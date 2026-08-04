# testbed-troubleshooter

A locally hosted web app that answers one question about the hub–spoke testbed:

> **is this broken at layer 2 or at layer 3 — and where exactly?**

It logs into the ESXi host and every VM in the path, reads the virtual network and the
guest network stacks, sends ARP/ICMP probes, and returns a verdict with the evidence
and the fix. Nothing is reconfigured: every command it runs is read-only.

```bash
cd testbed-troubleshooter
npm install
node server.js            # http://127.0.0.1:8791   (TS_PORT to change)
npm test                  # 42 offline checks (38 unit + 4 integration), no lab needed
```

The panel binds `127.0.0.1` only, so credentials never leave the machine.

## The three steps

1. **ESXi host** — IP, username (usually `root`), password. SSH must be enabled on the
   host (*Host → Actions → Services → Enable Secure Shell*). The tool reads vSwitches,
   portgroups + VLAN IDs, per-vNIC MACs and portgroup security policy. You can **Skip**
   this step; the L2 verdict then rests on in-guest evidence only, and the report says so.
2. **Testbed nodes** — client → spoke → *netem (optional)* → hub → server. Per node:
   the ESXi **VM name** (dropdown, filled from the host inventory), the **management IP**
   it SSHes into, credentials, and optionally the **data-plane IP** the test traffic uses.
   Leave the data IP blank and the first non-management address is used.
3. **Diagnose** — verdict, path diagram, per-segment table, ranked findings with the exact
   command output behind each one, and a shareable HTML report.

Configurations can be saved as named profiles (`profiles.json`, gitignored, mode 0600).
Blank passwords fall back to the saved profile, then to `ESXI_PASS`, `CLIENT_PASS`,
`SPOKE_PASS`, `NETEM_PASS`, `HUB_PASS`, `SERVER_PASS`.

## How the L2 / L3 call is made

For every adjacent pair in the chain the tool holds two *independent* facts:

| | source |
|---|---|
| do the two vNICs share an **L2 broadcast domain**? | ESXi: same portgroup, or same vSwitch + same VLAN, or bridged together inside a netem VM — resolved with a union-find over portgroups |
| do the two IPs share a **subnet**? | the guests: `ip -o -4 addr show` |

Cross-referencing them is what separates the two layers:

| same subnet | same L2 domain | ARP | verdict |
|---|---|---|---|
| yes | **no** | — | **L2** — portgroup mismatch (or VLAN mismatch when both are on one vSwitch) |
| no | yes | — | **L3** — addressing: frames arrive, the subnets do not line up |
| no | no | — | **L2** — the link does not exist yet (different domains *and* no shared subnet) |
| yes | yes | fails | **L2** — sub-cause ranked: link down → portgroup rejects the guest's MAC → duplicate MAC → no reply |
| yes | yes | wrong MAC | **L2** — MAC mismatch: something else answers for that IP (duplicate IP / stale entry) |
| yes | yes | ok, ICMP fails | **not L2** — ARP proves delivery, so it is a filter or `rp_filter` |
| yes | yes | ok, ICMP ok | segment clean → move on to the routing checks |

When every segment is clean but the flow still fails, the chain is walked at L3 and the
node that lacks the route is named: no route to the destination, next hop outside every
connected subnet, `ip_forward=0` on a transit node, missing return route, `FORWARD` policy
`DROP`, strict `rp_filter`, and the last traceroute hop that answered. A PMTU black hole
(small pings pass, DF-large ones do not) is reported separately, because it looks like
latency rather than a break.

The verdict is the earliest failing layer: **L2 → ACCESS → L3**. L2 findings come straight
from the ESXi configuration and hold even with a node down, whereas every L3 conclusion
depends on probes that need the whole chain reachable.

### The netem VM

A netem VM that bridges two portgroups has no IP on the bridge and is *not* an L3 hop, so
it is collapsed out of the routing chain while its two portgroups are merged into one L2
domain. That is why `spoke ↔ hub` still reads as adjacent even though the two vNICs sit in
different portgroups. Bridged ports are also checked for the policy that traps everyone:
a bridge needs **Forged transmits = Accept** (and normally **Promiscuous = Accept** and
**MAC address changes = Accept**) or the vSwitch silently drops every forwarded frame.

## What it runs

| where | commands |
|---|---|
| ESXi | `esxcli network vswitch standard list` / `portgroup list` / `portgroup policy security get` / `network nic list` / `network vm list` / `network vm port list`, `vim-cmd vmsvc/getallvms`, `esxcli system version get` |
| each guest | `ip -o -d link show`, `ip -o -4 addr show`, `ip -4 route show`, `ip -4 neigh show`, `ip route get`, `/proc/sys/net/ipv4/ip_forward`, `.../rp_filter`, `tc -s qdisc show`, `bridge link show`, `iptables -S` (sudo), `ping`, `arping`, `traceroute`/`tracepath`/TTL sweep |

`esxcli --formatter=json` is used when the host supports it, with plain-text table and
indented-block parsers as a fallback. Missing tooling degrades a single check instead of
failing the run: no `traceroute` falls back to `tracepath` and then to a `ping -t` TTL
sweep; no sudo means the firewall check is skipped with a warning.

## CLI

Same engine, for scripted use. Exits non-zero unless the verdict is healthy, so it can
gate a test run:

```bash
node troubleshoot.js --config testbed.json          # human-readable
node troubleshoot.js --config testbed.json --json   # the full report JSON
node troubleshoot.js --config testbed.json --no-probes   # configuration review, no packets
```

```json
{
  "esxi":  { "host": "172.16.226.10", "user": "root" },
  "nodes": {
    "client": { "host": "172.16.226.50",  "user": "root", "vmName": "client-vm", "dataIp": "10.10.1.2" },
    "spoke":  { "host": "172.16.226.113", "user": "root", "vmName": "spoke-vm" },
    "netem":  { "host": "172.16.226.199", "user": "root", "vmName": "netem-vm" },
    "hub":    { "host": "172.16.226.120", "user": "root", "vmName": "hub-vm" },
    "server": { "host": "172.16.226.60",  "user": "root", "vmName": "server-vm", "dataIp": "10.10.3.2" }
  },
  "options": { "maxHops": 12, "mtuBytes": 1500 }
}
```

Passwords are best left out of the file and passed as `ESXI_PASS`, `CLIENT_PASS`, … .

## Reports

Every run writes `reports/<timestamp>/report.html` and `report.json`. The HTML is
self-contained and safe to attach to a ticket; the JSON carries the full fact dump
(credentials replaced with `***`) for diffing two runs.

## Layout

```
server.js          web app: static files, JSON API, SSE progress stream
troubleshoot.js    CLI entry point
lib/engine.js      orchestration: collect -> topology -> probe -> diagnose -> report
lib/esxi.js        ESXi collectors + esxcli JSON/text parsers
lib/guest.js       guest collectors, probes, and their parsers
lib/diagnose.js    the decision engine — pure functions, no I/O
lib/ipmath.js      IPv4 subnet maths
lib/report.js      HTML + JSON report writers
public/            the three-step wizard (plain HTML/CSS/JS, no build step)
test/run_tests.js  parser + decision-engine tests against a synthetic testbed
test/integration_test.js
                   the real engine end to end against a faked SSH surface
```

`lib/diagnose.js` does no I/O at all, which is why the whole verdict matrix above is
testable without a lab: `test/run_tests.js` builds a synthetic ESXi host plus five guests
and bends one thing at a time (move a portgroup, retag a VLAN, spoof a MAC, drop a link,
disable forwarding) to assert the verdict each time. `test/integration_test.js` goes one
layer out: it fakes the SSH surface — real `esxcli` and `ip` output, per host — and runs
the actual collectors, probes, engine and report writer over it.
