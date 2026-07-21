#!/usr/bin/env python3
"""
SLA jtrace collector.

For each of the 36 SLA test cases (class x {latency,loss} x {upstream,downstream}):
  1. Identify the interface carrying test traffic on the NETEM VM (counter delta).
  2. Watch the newest DMTS hourlog slice on the spoke and detect the link switch
     (active TC's link_map[0] changes value).
  3. Dump the DMTS jtrace from the spoke GridVue after the switch and download it.
  4. Attach the jtrace file to the matching row on the Confluence results page
     and note the filename in that row's Logs cell.

Traffic generation and NETEM impairment are handled EXTERNALLY by the app on the
NETEM VM — this script only observes, downloads, and uploads.

Dependencies: paramiko, requests  (pip install paramiko requests)

Configuration is taken from environment variables (never hardcode secrets):
  SPOKE_HOST, SPOKE_USER, SPOKE_PASS      SSH to the spoke grid
  NETEM_HOST (default 172.16.226.199), NETEM_USER, NETEM_PASS
  CONF_EMAIL, CONF_TOKEN                  Atlassian API token auth
  CONF_BASE  (default https://espacenetworks.atlassian.net)
  CONF_PAGE  (default 4954357785)

Usage:
  python sla_jtrace_collector.py             # loop all 36 cases, operator-paced
  python sla_jtrace_collector.py --case 7    # run a single case
  python sla_jtrace_collector.py --list      # print the case/row table and exit
"""

import argparse
import json
import logging
import os
import re
import sys
import time
from datetime import datetime, timezone

import paramiko
import requests

# --------------------------------------------------------------------------- #
# FILL-IN TODOs — the three things this script cannot know by itself
# --------------------------------------------------------------------------- #

# TODO(1): absolute path of the DMTS hourlog directory on the spoke
# (the directory containing the rolling N.txt slices).
HOURLOG_DIR = "/TODO/path/to/hourLog"

# TODO(2): exact GridVue command that dumps the DMTS jtrace to stdout on the
# spoke, e.g. "gridvue dmts jtrace dump". If the command writes to a file
# instead of stdout, set JTRACE_REMOTE_PATH to that file and it will be
# downloaded via SFTP after the command runs.
JTRACE_DUMP_CMD = "TODO: gridvue dmts jtrace dump"
JTRACE_REMOTE_PATH = None  # e.g. "/tmp/dmts_jtrace.txt", or None for stdout

# TODO(3): the nine traffic classes, in the row order used on the Confluence
# page. Rows are assumed to be ordered class-major, then metric, then
# direction (see build_test_cases below) — adjust ROW_MAP overrides if the
# page uses a different order.
CLASSES = [
    "TODO_class_1",
    "TODO_class_2",
    "TODO_class_3",
    "TODO_class_4",
    "TODO_class_5",
    "TODO_class_6",
    "TODO_class_7",
    "TODO_class_8",
    "TODO_class_9",
]

METRICS = ["latency", "loss"]
DIRECTIONS = ["upstream", "downstream"]

# Optional explicit overrides: (class, metric, direction) -> row number 1-36.
# Anything not listed here falls back to the generated order below.
ROW_MAP_OVERRIDES: dict = {
    # ("TODO_class_1", "latency", "upstream"): 1,
}

# Index (0-based) of the Logs cell within each table row on the Confluence
# page. -1 means "the last cell in the row".
LOGS_CELL_INDEX = -1

# --------------------------------------------------------------------------- #
# Tunables
# --------------------------------------------------------------------------- #

IFACE_SAMPLE_SECONDS = 5.0    # gap between the two counter reads on NETEM VM
HOURLOG_POLL_SECONDS = 2.0    # how often to re-read the newest hourlog slice
HOURLOG_TAIL_BYTES = 262144   # how much of the slice tail to fetch each poll
SWITCH_TIMEOUT_SECONDS = 900  # give up waiting for a switch after this long
SSH_CMD_TIMEOUT = 60

log = logging.getLogger("sla-jtrace")


# --------------------------------------------------------------------------- #
# Config
# --------------------------------------------------------------------------- #

def env(name: str, default: str = None) -> str:
    val = os.environ.get(name, default)
    if val is None:
        sys.exit(f"ERROR: required environment variable {name} is not set")
    return val


class Config:
    def __init__(self):
        self.spoke_host = env("SPOKE_HOST")
        self.spoke_user = env("SPOKE_USER")
        self.spoke_pass = env("SPOKE_PASS")
        self.netem_host = env("NETEM_HOST", "172.16.226.199")
        self.netem_user = env("NETEM_USER")
        self.netem_pass = env("NETEM_PASS")
        self.conf_email = env("CONF_EMAIL")
        self.conf_token = env("CONF_TOKEN")
        self.conf_base = env("CONF_BASE", "https://espacenetworks.atlassian.net").rstrip("/")
        self.conf_page = env("CONF_PAGE", "4954357785")


# --------------------------------------------------------------------------- #
# SSH helpers (paramiko)
# --------------------------------------------------------------------------- #

def ssh_connect(host: str, user: str, password: str) -> paramiko.SSHClient:
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    log.info("SSH connect %s@%s", user, host)
    client.connect(
        host,
        username=user,
        password=password,
        look_for_keys=False,
        allow_agent=False,
        timeout=30,
    )
    return client


def ssh_exec(client: paramiko.SSHClient, command: str,
             timeout: float = SSH_CMD_TIMEOUT) -> tuple:
    """Run a command; return (exit_code, stdout, stderr)."""
    log.debug("ssh exec: %s", command)
    _, stdout, stderr = client.exec_command(command, timeout=timeout)
    out = stdout.read().decode(errors="replace")
    err = stderr.read().decode(errors="replace")
    rc = stdout.channel.recv_exit_status()
    if rc != 0:
        log.debug("ssh exec rc=%d stderr=%s", rc, err.strip()[:500])
    return rc, out, err


# --------------------------------------------------------------------------- #
# STEP 1 — active interface on the NETEM VM
# --------------------------------------------------------------------------- #

def read_iface_counters(client: paramiko.SSHClient) -> dict:
    """Parse /proc/net/dev into {iface: rx_bytes + tx_bytes}."""
    rc, out, err = ssh_exec(client, "cat /proc/net/dev")
    if rc != 0:
        raise RuntimeError(f"cannot read /proc/net/dev on NETEM VM: {err.strip()}")
    counters = {}
    for line in out.splitlines():
        if ":" not in line:
            continue
        name, rest = line.split(":", 1)
        fields = rest.split()
        if len(fields) < 9:
            continue
        counters[name.strip()] = int(fields[0]) + int(fields[8])  # rx + tx bytes
    return counters


def detect_active_interface(cfg: Config) -> str:
    """SSH to the NETEM VM, sample counters twice, return the busiest iface."""
    client = ssh_connect(cfg.netem_host, cfg.netem_user, cfg.netem_pass)
    try:
        first = read_iface_counters(client)
        log.info("sampling NETEM interface counters (%.0fs window)...",
                 IFACE_SAMPLE_SECONDS)
        time.sleep(IFACE_SAMPLE_SECONDS)
        second = read_iface_counters(client)
    finally:
        client.close()

    rates = {
        iface: (second[iface] - first.get(iface, 0)) / IFACE_SAMPLE_SECONDS
        for iface in second
        if iface != "lo"
    }
    if not rates:
        raise RuntimeError("no non-loopback interfaces found on NETEM VM")
    for iface, rate in sorted(rates.items(), key=lambda kv: -kv[1])[:5]:
        log.info("  %-12s %10.0f B/s", iface, rate)
    best = max(rates, key=rates.get)
    if rates[best] <= 0:
        log.warning("no interface shows traffic — is the test running?")
    log.info("active NETEM interface: %s (%.0f B/s)", best, rates[best])
    return best


# --------------------------------------------------------------------------- #
# STEP 2 — hourlog parsing and link-switch detection on the spoke
# --------------------------------------------------------------------------- #

def newest_hourlog_file(client: paramiko.SSHClient) -> str:
    rc, out, err = ssh_exec(
        client, f"ls -t {HOURLOG_DIR}/*.txt 2>/dev/null | head -1")
    path = out.strip()
    if rc != 0 or not path:
        raise RuntimeError(
            f"no hourlog slices found in {HOURLOG_DIR} (stderr: {err.strip()})")
    return path


def tail_file(client: paramiko.SSHClient, path: str,
              nbytes: int = HOURLOG_TAIL_BYTES) -> str:
    rc, out, err = ssh_exec(client, f"tail -c {nbytes} '{path}'")
    if rc != 0:
        raise RuntimeError(f"cannot tail {path}: {err.strip()}")
    return out


def last_complete_record(text: str, max_attempts: int = 5000) -> dict:
    """
    Tolerantly extract the last complete {...} hourlog record from a text
    blob. The tail chunk may start mid-record and the final record is often
    truncated, so we try json parsing at each '{' position walking backwards
    from the end; the first dict that parses completely and carries the
    record shape ("scores") is the newest complete record. Inner objects of a
    record parse fine but lack "scores", so they are skipped naturally.
    """
    decoder = json.JSONDecoder()
    positions = [i for i, ch in enumerate(text) if ch == "{"]
    for pos in reversed(positions[-max_attempts:]):
        try:
            rec, _ = decoder.raw_decode(text, pos)
        except ValueError:
            continue
        if isinstance(rec, dict) and "scores" in rec:
            return rec
    return None


def active_tc(record: dict):
    """
    Return (tc_name, tc_dict) for the TC carrying traffic: the scores.per_tc
    entry whose qoe is present and not IDLE/NOREF, excluding __internal_hp__.
    Returns (None, None) if no TC is active.
    """
    per_tc = (record.get("scores") or {}).get("per_tc") or {}
    for name, tc in per_tc.items():
        if name == "__internal_hp__" or not isinstance(tc, dict):
            continue
        qoe = tc.get("qoe")
        if qoe is None or str(qoe).upper() in ("IDLE", "NOREF"):
            continue
        return name, tc
    return None, None


def link_stats(record: dict, link_id) -> dict:
    """Find the channel entry for link_id; return its latency95P/packetLoss95P."""
    channels = record.get("channels") or []
    if isinstance(channels, dict):
        channels = list(channels.values())
    for ch in channels:
        if isinstance(ch, dict) and ch.get("link_id") == link_id:
            return {
                "latency95P": ch.get("latency95P"),
                "packetLoss95P": ch.get("packetLoss95P"),
            }
    return {"latency95P": None, "packetLoss95P": None}


def record_timestamp(record: dict) -> str:
    for key in ("timestamp", "time", "ts"):
        if key in record:
            return str(record[key])
    return datetime.now(timezone.utc).isoformat()


def wait_for_link_switch(client: paramiko.SSHClient,
                         timeout: float = SWITCH_TIMEOUT_SECONDS) -> dict:
    """
    Poll the newest hourlog slice until the active TC's link_map[0] changes.
    Returns {tc, from_link, to_link, switch_time, latency95P, packetLoss95P}.
    """
    deadline = time.monotonic() + timeout
    prev_link = None
    prev_record = None
    logfile = newest_hourlog_file(client)
    log.info("watching hourlog slice %s for link switch (timeout %.0fs)",
             logfile, timeout)

    while time.monotonic() < deadline:
        # The newest slice can roll over on the hour — re-check periodically.
        current = newest_hourlog_file(client)
        if current != logfile:
            log.info("hourlog rolled over: %s -> %s", logfile, current)
            logfile = current

        record = last_complete_record(tail_file(client, logfile))
        if record is None:
            log.debug("no complete record parsed yet")
            time.sleep(HOURLOG_POLL_SECONDS)
            continue

        tc_name, tc = active_tc(record)
        if tc_name is None:
            log.debug("no active TC in latest record")
            time.sleep(HOURLOG_POLL_SECONDS)
            continue

        link_map = tc.get("link_map") or []
        if not link_map:
            time.sleep(HOURLOG_POLL_SECONDS)
            continue
        link = link_map[0]

        if prev_link is None:
            prev_link = link
            log.info("active TC %s currently on link %s — waiting for switch",
                     tc_name, link)
        elif link != prev_link:
            # Stats of the from-link at the switch: prefer the current record
            # (the from-link channel is still reported), fall back to the
            # last record seen before the switch.
            stats = link_stats(record, prev_link)
            if stats["latency95P"] is None and prev_record is not None:
                stats = link_stats(prev_record, prev_link)
            switch = {
                "tc": tc_name,
                "from_link": prev_link,
                "to_link": link,
                "switch_time": record_timestamp(record),
                "latency95P": stats["latency95P"],
                "packetLoss95P": stats["packetLoss95P"],
            }
            log.info("LINK SWITCH detected: TC %s moved %s -> %s at %s "
                     "(from-link latency95P=%s ms, packetLoss95P=%s %%)",
                     switch["tc"], switch["from_link"], switch["to_link"],
                     switch["switch_time"], switch["latency95P"],
                     switch["packetLoss95P"])
            return switch

        prev_record = record
        time.sleep(HOURLOG_POLL_SECONDS)

    raise TimeoutError(
        f"no link switch observed within {timeout:.0f}s — aborting this case")


# --------------------------------------------------------------------------- #
# STEP 3 — jtrace dump from spoke GridVue
# --------------------------------------------------------------------------- #

def dump_jtrace(client: paramiko.SSHClient, local_path: str) -> str:
    """Run the GridVue jtrace dump on the spoke and save it locally."""
    if JTRACE_DUMP_CMD.startswith("TODO"):
        raise RuntimeError(
            "JTRACE_DUMP_CMD is not filled in — set the exact GridVue jtrace "
            "dump command at the top of this script")

    log.info("dumping jtrace on spoke: %s", JTRACE_DUMP_CMD)
    rc, out, err = ssh_exec(client, JTRACE_DUMP_CMD, timeout=300)
    if rc != 0:
        raise RuntimeError(
            f"jtrace dump failed (rc={rc}): {err.strip()[:1000]}")

    if JTRACE_REMOTE_PATH:
        log.info("downloading %s via SFTP", JTRACE_REMOTE_PATH)
        sftp = client.open_sftp()
        try:
            sftp.get(JTRACE_REMOTE_PATH, local_path)
        finally:
            sftp.close()
    else:
        if not out.strip():
            raise RuntimeError("jtrace dump produced no stdout output")
        with open(local_path, "w", encoding="utf-8") as fh:
            fh.write(out)

    size = os.path.getsize(local_path)
    log.info("jtrace saved: %s (%d bytes)", local_path, size)
    if size == 0:
        raise RuntimeError(f"jtrace file {local_path} is empty")
    return local_path


# --------------------------------------------------------------------------- #
# STEP 4 — Confluence attachment upload + Logs-cell note
# --------------------------------------------------------------------------- #

def conf_auth(cfg: Config):
    return (cfg.conf_email, cfg.conf_token)


def upload_attachment(cfg: Config, filepath: str) -> str:
    url = (f"{cfg.conf_base}/wiki/rest/api/content/"
           f"{cfg.conf_page}/child/attachment")
    filename = os.path.basename(filepath)
    log.info("uploading attachment %s to page %s", filename, cfg.conf_page)
    with open(filepath, "rb") as fh:
        resp = requests.post(
            url,
            auth=conf_auth(cfg),
            headers={"X-Atlassian-Token": "no-check"},
            files={"file": (filename, fh, "text/plain")},
            timeout=120,
        )
    if resp.status_code not in (200, 201):
        raise RuntimeError(
            f"attachment upload failed: HTTP {resp.status_code} "
            f"{resp.text[:500]}")
    log.info("attachment uploaded: %s", filename)
    return filename


def get_page(cfg: Config) -> dict:
    url = f"{cfg.conf_base}/wiki/rest/api/content/{cfg.conf_page}"
    resp = requests.get(
        url,
        auth=conf_auth(cfg),
        params={"expand": "body.storage,version"},
        timeout=60,
    )
    resp.raise_for_status()
    return resp.json()


def note_filename_in_row(storage: str, row_number: int, filename: str) -> str:
    """
    Insert an attachment link into the Logs cell of data row `row_number`
    (1-based, header rows excluded) in the page's storage-format body.
    Assumes the 36-case results table is the one on the page with >= 36
    data rows.
    """
    rows = list(re.finditer(r"<tr\b[^>]*>.*?</tr>", storage, re.S))
    data_rows = [m for m in rows if "<th" not in m.group(0)]
    if len(data_rows) < row_number:
        raise RuntimeError(
            f"page has only {len(data_rows)} data rows — cannot update "
            f"row {row_number}; check the table structure / ROW_MAP")

    row = data_rows[row_number - 1]
    cells = list(re.finditer(r"<td\b[^>]*>(.*?)</td>", row.group(0), re.S))
    if not cells:
        raise RuntimeError(f"row {row_number} contains no <td> cells")
    cell = cells[LOGS_CELL_INDEX]

    note = (f'<p><ac:link><ri:attachment ri:filename="{filename}"/>'
            f"</ac:link></p>")
    if filename in row.group(0):
        log.info("row %d already references %s — skipping cell edit",
                 row_number, filename)
        return storage

    # Splice: insert the note just before the cell's closing </td>.
    cell_end_in_row = cell.end(1)          # offset within the row string
    abs_pos = row.start() + cell_end_in_row
    return storage[:abs_pos] + note + storage[abs_pos:]


def update_logs_cell(cfg: Config, row_number: int, filename: str) -> None:
    for attempt in (1, 2):
        page = get_page(cfg)
        if str(page.get("id")) != str(cfg.conf_page):
            raise RuntimeError(
                f"page id mismatch: got {page.get('id')}, "
                f"expected {cfg.conf_page} — refusing to write")
        storage = page["body"]["storage"]["value"]
        new_storage = note_filename_in_row(storage, row_number, filename)
        if new_storage == storage:
            return
        payload = {
            "id": cfg.conf_page,
            "type": "page",
            "title": page["title"],
            "version": {"number": page["version"]["number"] + 1,
                        "message": f"attach {filename} to row {row_number}"},
            "body": {"storage": {"value": new_storage,
                                 "representation": "storage"}},
        }
        resp = requests.put(
            f"{cfg.conf_base}/wiki/rest/api/content/{cfg.conf_page}",
            auth=conf_auth(cfg),
            json=payload,
            timeout=60,
        )
        if resp.status_code == 409 and attempt == 1:
            log.warning("version conflict updating page — retrying once")
            continue
        if resp.status_code != 200:
            raise RuntimeError(
                f"page update failed: HTTP {resp.status_code} "
                f"{resp.text[:500]}")
        log.info("Logs cell of row %d updated with %s", row_number, filename)
        return


# --------------------------------------------------------------------------- #
# Test-case table
# --------------------------------------------------------------------------- #

def build_test_cases():
    """36 cases: class-major, then metric, then direction. Row = index + 1
    unless overridden in ROW_MAP_OVERRIDES."""
    cases = []
    n = 0
    for cls in CLASSES:
        for metric in METRICS:
            for direction in DIRECTIONS:
                n += 1
                row = ROW_MAP_OVERRIDES.get((cls, metric, direction), n)
                cases.append({
                    "n": n,
                    "class": cls,
                    "metric": metric,
                    "direction": direction,
                    "row": row,
                })
    return cases


def sanitize(s: str) -> str:
    return re.sub(r"[^A-Za-z0-9_-]+", "_", s).strip("_")


# --------------------------------------------------------------------------- #
# Per-case driver
# --------------------------------------------------------------------------- #

def run_case(cfg: Config, case: dict, outdir: str,
             timeout: float = SWITCH_TIMEOUT_SECONDS) -> None:
    label = f"case {case['n']}/36 [{case['class']} / {case['metric']} / {case['direction']}]"
    log.info("=== %s — row %d ===", label, case["row"])

    # Step 1 — which NETEM interface carries the traffic
    iface = detect_active_interface(cfg)

    # Step 2 — watch the spoke hourlog for the link switch
    spoke = ssh_connect(cfg.spoke_host, cfg.spoke_user, cfg.spoke_pass)
    try:
        switch = wait_for_link_switch(spoke, timeout)

        # Step 3 — jtrace dump after the switch
        ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        fname = (f"jtrace_{sanitize(case['class'])}_{case['metric']}_"
                 f"{case['direction']}_{ts}.txt")
        local_path = os.path.join(outdir, fname)
        dump_jtrace(spoke, local_path)
    finally:
        spoke.close()

    # Prepend a small provenance header so the attachment is self-describing.
    header = (
        f"# SLA test case {case['n']}: class={case['class']} "
        f"metric={case['metric']} direction={case['direction']}\n"
        f"# netem_iface={iface} tc={switch['tc']} "
        f"from_link={switch['from_link']} to_link={switch['to_link']}\n"
        f"# switch_time={switch['switch_time']} "
        f"from_link_latency95P={switch['latency95P']} "
        f"from_link_packetLoss95P={switch['packetLoss95P']}\n"
    )
    with open(local_path, "r", encoding="utf-8", errors="replace") as fh:
        body = fh.read()
    with open(local_path, "w", encoding="utf-8") as fh:
        fh.write(header + body)

    # Step 4 — attach + note in the row's Logs cell
    filename = upload_attachment(cfg, local_path)
    update_logs_cell(cfg, case["row"], filename)
    log.info("=== %s DONE — %s attached to row %d ===",
             label, filename, case["row"])


# --------------------------------------------------------------------------- #
# Main
# --------------------------------------------------------------------------- #

def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[1])
    ap.add_argument("--case", type=int, metavar="N",
                    help="run only test case N (1-36)")
    ap.add_argument("--list", action="store_true",
                    help="print the 36-case table and exit")
    ap.add_argument("--outdir", default="jtraces",
                    help="local directory for downloaded jtrace files")
    ap.add_argument("--timeout", type=float, default=SWITCH_TIMEOUT_SECONDS,
                    help="seconds to wait for a link switch per case")
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)-7s %(message)s",
        handlers=[
            logging.StreamHandler(),
            logging.FileHandler("sla_jtrace_collector.log", encoding="utf-8"),
        ],
    )

    cases = build_test_cases()

    if args.list:
        for c in cases:
            print(f"case {c['n']:2d}  row {c['row']:2d}  "
                  f"{c['class']:<20} {c['metric']:<8} {c['direction']}")
        return 0

    if HOURLOG_DIR.startswith("/TODO"):
        sys.exit("ERROR: HOURLOG_DIR is not filled in — set it at the top of "
                 "this script")

    cfg = Config()
    os.makedirs(args.outdir, exist_ok=True)

    if args.case is not None:
        if not 1 <= args.case <= 36:
            sys.exit("ERROR: --case must be 1-36")
        run_case(cfg, cases[args.case - 1], args.outdir, args.timeout)
        return 0

    failed = []
    for case in cases:
        print(f"\n>>> Ready for case {case['n']}/36: "
              f"{case['class']} / {case['metric']} / {case['direction']}")
        answer = input(">>> Start the test on the NETEM app, then press Enter "
                       "(or type 'skip' / 'quit'): ").strip().lower()
        if answer == "quit":
            break
        if answer == "skip":
            log.info("case %d skipped by operator", case["n"])
            continue
        try:
            run_case(cfg, case, args.outdir, args.timeout)
        except (TimeoutError, RuntimeError, paramiko.SSHException,
                requests.RequestException) as exc:
            log.error("case %d FAILED: %s", case["n"], exc)
            failed.append(case["n"])

    if failed:
        log.warning("finished with failures in cases: %s", failed)
        return 1
    log.info("all requested cases completed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
