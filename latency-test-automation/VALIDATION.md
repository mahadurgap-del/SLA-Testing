# Validation checklist

Treat this as the QA gate: **feature work is frozen until every row is ✅.**
Statuses: ✅ verified · 🧪 covered by offline tests, needs one live confirmation ·
⏳ not yet validated live · procedure = how to verify it on the lab.

Run everything below with **Debug mode ON** (pause after each stage) and a short
duration (`--duration 120`, baseline 120) unless stated otherwise. Every run
writes `automation.log` ([PASS]/[FAIL] per checkpoint) — attach it plus the TC's
`observations.txt` when reporting a failure.

| # | Component | Status | How to verify |
|---|-----------|--------|---------------|
| 1 | SSH connections (client/server/spoke/hub/netem VM) | ✅ verified live 2026-07-21 | Pre-flight checkpoints all PASS in the 17:41 run. |
| 2 | Confluence auth + page access | ✅ verified live 2026-07-21 | `Confluence auth` / `Confluence target` checkpoints PASS. |
| 3 | Traffic generation (iperf3 over SSH, data-plane target, `-B` bind, `-R` downstream) | ✅ verified live 2026-07-21 | Client verified at 4320 pps on ens192; for downstream tick the radio and confirm `-R` in the preview + `iperf3 -R` visible in `ps -ef \| grep iperf3` on the client. |
| 4 | Traffic verification (netem-NIC pps, client liveness) | ✅ verified live 2026-07-21 | `[PASS] Traffic verified — 4320 pps over ens192`. Negative test: start a run with a wrong server traffic IP — must FAIL EARLY with client output in the log. |
| 5 | Active link detection (correct overlay NIC, bridge shown) | ⏳ | During a run compare the detection table (`ensX … pps (bridge brY)`) against the netem UI's live counters AND GridVue `grid topt show` (which channel carries Browsing). Repeat once with traffic moved to the other link. Set the candidates field to make it deterministic. |
| 6 | Latency injection (drawn value applied + read back) | ⏳ | Run TC2 in debug mode; at the "netem applied" pause run `tc qdisc show dev <iface>` on the netem VM yourself and compare with the `[PASS] Netem applied … (verified by tc qdisc show)` checkpoint. |
| 7 | Latency on the correct SIDE (higher delay on active link, lower on the standby link's bridge) | ⏳ | TC3 in debug mode: at the pause run `tc qdisc show` for both NICs — the active-link NIC carries the MEO draw (higher), a NIC on the OTHER bridge carries the LEO draw. The impairment log lines must name two different bridges. |
| 8 | Packet-loss schedules (ramp / burst / random) | 🧪 offline-tested | Run `--mode packet-loss --tc 1 --duration 180`: expect loss 2%→4%→6% checkpoints each 60 s, `tc qdisc show` matching, and clear on exit. |
| 9 | Link-switch detection (hourLog) | ⏳ | TC2 with a GEO-sized delay if needed: `[PASS] Link switch detected` must appear within ~1 min of GridVue showing Browsing move over1→over2. Also verify TC1 records NO switch (expected-no-switch = PASS). |
| 10 | HourLog parsing & rollover | 🧪 offline-tested (truncated tails, garbage, brace-in-string) | Run a case across the top of an hour; the log must show `hourlog rolled over: N.txt -> M.txt` and monitoring continue. |
| 11 | Log collection (hourLog, curLog, ubd, ubdLatest.tar, full archive — spoke+hub) | ✅ verified live 2026-07-21 (TC1 16:12 run) | Files present under `Latency_Test/<TC>/spoke\|hub/`; also verify the **failure path**: force a traffic-verify failure and confirm collection still runs. |
| 12 | Diag Pack collection | ⏳ blocked on TODO | Fill in `DIAG_PACK_CMD`/glob or `GRID_UI_URL_*` + selectors, then confirm a pack lands per TC. Currently skipped with a WARN. |
| 13 | Report generation (observations/summary.json/summary.md/report.html incl. drawn latency values) | 🧪 offline-tested | After any full run open `report.html`; per-TC Configuration must show e.g. `35 ms (LEO) / 159 ms (MEO)` matching automation.log's "latency draws this run" line. |
| 14 | Confluence upload (sections, checklist, attachments incl. per-TC renames) | ⏳ | One full short run with upload ON; verify the page section + all attachments open; verify a SECOND run appends rather than clobbers. |
| 15 | Cleanup: netem cleared after each case + run-end safety net; pre-run reports (does NOT blanket-delete — the netem VM app owns its qdiscs) | 🧪 offline-tested (registry) | `Netem VM clean state` checkpoint at run start REPORTS present netem qdiscs and only clears ones this process applied (or candidates when `NETEM_SANITIZE=all`). Per-case: our `tc qdisc del` restores after each case. Our apply uses `tc qdisc replace` so app-managed qdiscs are overridden cleanly, not destroyed at run start. |
| 15b | Netem VM sudo/tc usable | ✅ pre-flight check + offline-proven password feed | Pre-flight `Netem VM sudo tc` checkpoint runs `sudo tc -Version` (20s cap). Password is fed on a prompt from stdout OR stderr, plus a proactive feed — proven with a mock. If sudo needs a password not supplied / no NOPASSWD, this FAILS at Phase 1 instead of hanging mid-ramp. |
| 16 | Cleanup: iperf stopped on both ends on every exit path (success/early-fail/abort/monitor crash) | 🧪 idempotent stop wired to all paths | After each scenario: `pgrep -a iperf3` on client and server must be empty. Also covered at next start (pkill before launch). |
| 17 | Stop button / Ctrl+C mid-case | ✅ verified logic offline; ⏳ one live click | Press Stop during monitoring: case → ABORTED, netem cleared, iperf gone, Start re-enabled. |
| 18 | Debug mode gates | ✅ verified live 2026-07-21 (17:41 run) | Pauses + Continue observed at phase 1, traffic validated, netem applied. |
| 19 | SSH disconnect resilience | 🧪 per-op reconnect + retry; schedule loops retry per tick | During monitoring, restart sshd on the spoke (`sudo systemctl restart sshd`); expect WARN lines then recovery, not a dead case. |
| 20 | Playwright screenshots | ⏳ known-degraded | `spawn UNKNOWN` when the panel is launched from the agent shell; start `node ui_server.js` from a normal terminal and confirm screenshots appear under `<TC>/screenshots/`. Run degrades gracefully either way. |

## Known open items (not bugs, decisions/TODOs)
- `expectSwitch` for TC2–TC4 and the three PL cases assumes the plan expects a
  switch; adjust per DMTS thresholds (`limit_on_latency_difference`) if not.
- Diag Pack command/UI selectors (row 12) still TODO.
- netem-ui Playwright selectors only matter if the `netem-ui` drivers are used.
- The netem VM's own app config: `tc qdisc replace/del root` overrides it during
  tests and sanitize removes any netem qdisc at run start — re-apply app-managed
  netem settings after test sessions if you use both.
