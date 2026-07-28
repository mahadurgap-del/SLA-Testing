# DMTS Log Path Audit — SLA Automation

**Scope:** static code audit only. No live testbed was queried for this document.
**Repository:** `mahadurgap-del/SLA-Testing`, branch `sla-full-regression-profile`
**Audited file:** `latency-test-automation/run_latency_tests.js` (plus `run_regression.js` for node selection)
**Question:** does the automation read the same DMTS log location that exists on the spoke
(`/var/log/dmts/hourLog`, `/var/log/dmts/curLog`, `/var/log/dmts/ubd`)?

**Verdict: YES. The paths in the code match the paths on the node, and no alternative path exists anywhere in the code.**

---

## 1. Path definitions

`run_latency_tests.js`, lines 75–76 — the only two path constants in the codebase:

```js
75  const DMTS_LOG_DIR = "/var/log/dmts";
76  const HOURLOG_DIR  = `${DMTS_LOG_DIR}/hourLog`;     // -> /var/log/dmts/hourLog
```

Every other reference derives from `DMTS_LOG_DIR`.

## 2. Exact paths used

| Log | Path resolved by the code | Defined / used at |
|---|---|---|
| hourLog | `/var/log/dmts/hourLog` | line 76 (`HOURLOG_DIR`) |
| curLog | `/var/log/dmts/curLog` | line 2723 — `tar czf ... -C /var/log/dmts curLog` |
| ubd | `/var/log/dmts/ubd` | line 2617 (`DMTS_COMPONENTS`), line 2649 |
| ubdLatest.tar | `/var/log/dmts/ubdLatest.tar` | line 2673 |

## 3. Comparison with the spoke (172.16.226.113)

| Path on the node | Present in code | Reference |
|---|---|---|
| `/var/log/dmts/hourLog` | YES | line 76 |
| `/var/log/dmts/curLog` | YES | line 2723 |
| `/var/log/dmts/ubd` | YES | lines 2617, 2649 |

No other directory is referenced. There is no fallback or alternative location.

## 4. Where switch detection reads DMTS logs

Execution flow, all in `run_latency_tests.js`:

```
monitorLinkSwitches()                                   line 1011   <- switch-detection loop
  |
  +- newestHourlogFile(conn)                            line 938
  |     ls -t /var/log/dmts/hourLog/*.txt | head -1     line 939
  |
  +- every 2 s:  tail -c 262144 '<newest file>'         line 1030
  +- lastCompleteRecord(tail)                           line 1031
  +- activeTcs(record)                                  line 1032
        reads tc_link_rate[] / dmts_output[] -> per-traffic-class link
        a changed link id == LINK SWITCH
```

**Switch detection reads only `/var/log/dmts/hourLog/*.txt`** — newest file, last 256 KB, polled
every 2 seconds.

Other readers of the same path:

| Purpose | Function | Line |
|---|---|---|
| Newest record content-time (window coverage proof) | `newestHourlogRecordTimeMs` | 955–956 |
| Pre-flight: directory exists + file count | `validateRegressionPreflight` | 2211–2216 |
| Pre-flight: records are fresh | `validateRegressionPreflight` | 2226 |
| Per-case evidence snapshot | `collectHourlogSnapshot` | 2690 |

## 5. Which node's logs are collected

```js
run_regression.js  :378   monitorSide: c.direction === "downstream" ? "hub" : "spoke"
run_latency_tests.js:2877 const monSide  = tc.monitorSide === "hub" ? "hub" : "spoke";
run_latency_tests.js:2878 const monCreds = monSide === "hub" ? cfg.hub : cfg.spoke;
run_latency_tests.js:2879 const monDir   = monSide === "hub" ? hubDir : spokeDir;
```

| Test direction | Node monitored and collected |
|---|---|
| upstream | **spoke** |
| downstream | **hub** |

Exactly one node per case — the direction's own DMTS. The other side is not read or collected
for that case.

## 6. Hardcoded or configurable?

**`/var/log/dmts` is HARDCODED** — a module constant at line 75.

Verified absent: no `envOr("DMTS...")` entry, no `dmtsLogDir` parameter, no UI field. It cannot be
overridden by configuration or environment variable.

What *is* configurable: the **node** the path is read from (spoke / hub SSH host, user, credentials
are all supplied through the UI). The **directory on that node** is fixed.

## 7. Scope of this audit

This audit confirms the log paths are correct. It does **not** assert that the end-to-end run has
been exercised successfully — at the time of writing, the lab overlay was down (no traffic path
between client and server), so a full case with impairment applied, a link switch detected and a
fresh hourLog collected had not yet completed.

## How to reproduce this audit

```bash
cd latency-test-automation
grep -n "DMTS_LOG_DIR\s*=\|HOURLOG_DIR\s*=" run_latency_tests.js      # path definitions
grep -n "HOURLOG_DIR" run_latency_tests.js                            # every hourLog use
grep -nE "/var/log/dmts|curLog|ubdLatest" run_latency_tests.js        # every literal path
grep -n "monitorSide" run_regression.js run_latency_tests.js          # node per direction
grep -nE "envOr\(\"DMTS|dmtsLogDir" run_latency_tests.js ui_server.js # configurability (no match)
```
