# SLA Testing

Automation tooling for SLA / impairment validation on the hub–spoke grid.

| Tool | Purpose |
|---|---|
| [`latency-test-automation/`](latency-test-automation/) | Runs the 4-scenario netem latency / packet-loss suites: configures netem via the web panel (Playwright), generates traffic over SSH (iperf3 / Scapy / tcpreplay / custom), watches the spoke DMTS hourlog for link switches, collects DMTS logs + Grid Diag Packs from Hub and Spoke, produces `summary.md` / `summary.json` / `report.html`, and publishes results to Confluence. CLI wizard **and** local web control panel. |
| [`sla-jtrace-collector/`](sla-jtrace-collector/) | For each of the 36 SLA test cases, detects the link switch in the spoke DMTS hourlog, downloads the GridVue jtrace, and attaches it to the matching row on the Confluence results page. |
| [`testbed-troubleshooter/`](testbed-troubleshooter/) | Local web app that isolates a broken testbed to **layer 2** (portgroup mismatch, VLAN mismatch, MAC mismatch, link down) or **layer 3** (missing route, forwarding off, no return route, filtering) and names the exact segment or node. Reads the ESXi host and every VM (client / spoke / netem / hub / server) over SSH, probes ARP + ICMP, and produces a report. Read-only. |

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

## Quick start — testbed-troubleshooter

```bash
cd testbed-troubleshooter
npm install
node server.js            # http://127.0.0.1:8791
npm test                  # 42 offline checks, no lab needed
```

Step 1 asks for the ESXi host (IP / username / password), step 2 for the client, spoke,
netem (optional), hub and server, step 3 returns the L2-or-L3 verdict with evidence and a
fix. Also runs headless: `node troubleshoot.js --config testbed.json`.

## Quick start — sla-jtrace-collector

```bash
cd sla-jtrace-collector
pip install -r requirements.txt
python sla_jtrace_collector.py --list
```

Both tools log every step and never modify Confluence pages other than the configured target.
