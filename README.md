# SLA Testing

Automation tooling for SLA / impairment validation on the hub–spoke grid.

| Tool | Purpose |
|---|---|
| [`latency-test-automation/`](latency-test-automation/) | Runs the 4-scenario netem latency / packet-loss suites: configures netem via the web panel (Playwright), generates traffic over SSH (iperf3 / Scapy / tcpreplay / custom), watches the spoke DMTS hourlog for link switches, collects DMTS logs + Grid Diag Packs from Hub and Spoke, produces `summary.md` / `summary.json` / `report.html`, and publishes results to Confluence. CLI wizard **and** local web control panel. |
| [`sla-jtrace-collector/`](sla-jtrace-collector/) | For each of the 36 SLA test cases, detects the link switch in the spoke DMTS hourlog, downloads the GridVue jtrace, and attaches it to the matching row on the Confluence results page. |

## Quick start — latency-test-automation

```bash
cd latency-test-automation
npm install && npx playwright install chromium

# Web control panel (recommended): http://127.0.0.1:8790
node ui_server.js

# Or the CLI wizard
node run_latency_tests.js
```

Lab defaults: netem panel `http://172.16.226.199:8080/` (netem VM SSH `172.16.226.199`),
spoke `172.16.226.113`. Credentials are entered in the panel / wizard, loaded from
env vars, or saved as connection profiles (`profiles.json`, gitignored).

### SLA Full Regression (6×7 Matrix) — one-click regression profile

The control panel has a **Run type** toggle at the top. Selecting **SLA Full
Regression (6×7 Matrix)** runs the complete unattended matrix — 2 directions
(upstream / downstream) × 3 ToS (`0x04`, `0x24`, `0x38`) × [Latency TC1–TC4 +
Packet-Loss TC1–TC3] = **42 test cases** — with everything fixed by the profile.
You supply only the connection targets (Client, Server, Spoke, Hub, Netem VM) and
Confluence credentials; runtime, latency/packet-loss progression, log collection,
reports, diag packs, hourlog snapshots, screenshots and Confluence upload are all
preset.

- **Observations only** — no PASS/FAIL is ever recorded (manual validation later).
- After **every** test case it collects logs, generates the report, and appends a
  **row + detail section to one shared Confluence page** (created once per run).
- **Resume** — progress is checkpointed to `run_state.json` after each case. If the
  run is stopped or the tool crashes, the panel shows a *Resume / Restart / Cancel*
  banner on next launch and continues from the next pending case (completed cases
  are never re-run, and it keeps appending to the same Confluence page).

Latency progression (active link ramps, standby held fixed): TC1 baseline 0/0;
TC2 30→130 ms (standby 0); TC3 30→400 ms (standby 150); TC4 150→1500 ms (standby
600) — hold 3 min, then +50 ms/min until switch or ceiling. Packet-loss: PL1
constant 2→20 % (+2 %/min after a 3-min hold); PL2 burst 5 % for 7 s every 30 s;
PL3 random 5 % (gap 20–60 s, dur 5–15 s) — PL2/PL3 hold clean for 3 min first.

CLI equivalent (uses the saved `profiles.json __default__`):

```bash
node run_regression.js            # fresh full run
node run_regression.js --resume   # continue an interrupted run
node run_regression.js --restart  # discard state and start over
```

The **Custom Run** flow (single combination, PASS/FAIL) is unchanged.

## Quick start — sla-jtrace-collector

```bash
cd sla-jtrace-collector
pip install -r requirements.txt
python sla_jtrace_collector.py --list
```

Both tools log every step and never modify Confluence pages other than the configured target.
