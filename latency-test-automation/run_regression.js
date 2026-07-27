#!/usr/bin/env node
/**
 * SLA Full Regression (6x7 Matrix) — one-click regression profile with resume.
 *
 * Runs the complete matrix, unattended:
 *   2 directions (upstream, downstream) x 3 ToS (0x04, 0x24, 0x38)
 *   x [ Latency TC1-TC4 + Packet-Loss PL_TC1-PL_TC3 ]  =  42 test cases.
 *
 * This is an ADDITIVE layer on top of the existing engine (run_latency_tests.js).
 * The Custom Run flow (runSuite / the web form / run_matrix.js) is untouched.
 *
 * For every test case, in order, it:
 *   1. runs traffic + impairment via the engine's runTestCase(),
 *   2. collects Spoke/Hub logs + Diag Packs + iperf logs + screenshots,
 *   3. writes the HTML report / summary.json / observations.txt,
 *   4. appends a row to the summary table AND a detail section on ONE shared
 *      Confluence page (created once, reused on resume),
 *   5. checkpoints run_state.json.
 *
 * Observations only — NO PASS/FAIL is ever recorded. Manual validation later.
 *
 * Resume: if run_state.json shows an unfinished run, runRegression(..., {resume:true})
 * skips every completed case and continues from the next pending one, appending
 * to the same Confluence page.
 *
 * The operator supplies ONLY: Client, Server, Spoke, Hub, Netem VM and Confluence
 * credentials. Everything else (runtime, latency progression, packet-loss
 * progression, Confluence upload, log collection, reports, diag packs, hourlog,
 * screenshots, observations) is fixed by this profile.
 *
 * Usage:
 *   node run_regression.js            # fresh full run (uses profiles.json __default__)
 *   node run_regression.js --resume   # continue an interrupted run
 *   node run_regression.js --restart  # discard state and start over
 */
"use strict";

const fs = require("fs");
const path = require("path");
const engine = require("./run_latency_tests.js");

const PROFILE_NAME = "SLA Full Regression (6x7 Matrix)";
const STATE_FILE = path.join(__dirname, "run_state.json");
const BASE_DIR = path.join(process.cwd(), "SLA_Regression");
const TOTAL = 42;

/* ========================================================================= *
 * Matrix definition — the fixed 6x7 grid and per-TC progression plans.
 * ========================================================================= */

const DIRECTIONS = [
  { key: "upstream", short: "UP", label: "Upstream" },
  { key: "downstream", short: "DN", label: "Downstream" },
];
const TOS_LIST = ["0x04", "0x24", "0x38"];

// Latency suite. Each entry carries BOTH the original SLA-matrix spec (active/
// standby/ceiling uniform ramp) and an `iptv` spec modelled on the IPTV Testing
// Confluence page. buildMatrix() resolves one or the other per mode.
//   IPTV latency: TC2 steps the active (LEO) link through an explicit per-
//   direction sequence; TC3/TC4 HOLD fixed active/standby and observe.
// Latency suite. IPTV/orbit spec follows the SLA Test Execution Criteria:
// configure latency by orbit profile and ramp one step per minute through the
// orbit's progression (standby link clean), monitoring for a switch to the
// alternate link. On switch, traffic is left to stabilise before the hourLog is
// collected; if no switch, the case runs the full 5-minute window.
//   LEO 30–120ms:  30 → 50 → 75 → 100 → 120
//   MEO 150–180ms: 150 → 165 → 180
//   GEO 600–1000ms: 600 → 800 → 1000
const LATENCY_TCS = [
  { tc: "TC1", label: "Baseline", baseline: true, active: 0, standby: 0, ceiling: 0,
    iptv: { label: "Baseline" } },
  { tc: "TC2", label: "LEO", active: 30, standby: 0, ceiling: 130,
    iptv: { label: "LEO Latency", standby: 0,
            steps: { upstream: [30, 50, 75, 100, 120], downstream: [30, 50, 75, 100, 120] } } },
  { tc: "TC3", label: "MEO", active: 150, standby: 0, ceiling: 400,
    iptv: { label: "MEO Latency", standby: 0,
            steps: { upstream: [150, 165, 180], downstream: [150, 165, 180] } } },
  { tc: "TC4", label: "GEO", active: 600, standby: 0, ceiling: 1500,
    iptv: { label: "GEO Latency", standby: 0,
            steps: { upstream: [600, 800, 1000], downstream: [600, 800, 1000] } } },
];

// Packet-loss suite. IPTV/orbit spec follows the criteria: start at 0% loss and
// increase gradually (+2% every 60s, e.g. 0 → 2 → 4 → 6 → 8 → 10). Monitor for a
// switch; on switch let traffic stabilise before collecting the hourLog, else run
// the full 5-minute window. Ceiling is 10% by default (override with --lossmax).
const PL_TCS = [
  { tc: "PL_TC1", label: "Constant Loss", plType: "constant", initialPct: 2, stepPct: 2, ceilingPct: 20,
    iptv: { label: "Constant Loss", plType: "constant", initialPct: 0, stepPct: 2, ceilingPct: 10 } },
  { tc: "PL_TC2", label: "Burst Loss", plType: "burst",
    iptv: { label: "Periodic Loss", plType: "periodic", initialPct: 0, stepPct: 2, ceilingPct: 10, onSec: 20, offSec: 20 } },
  { tc: "PL_TC3", label: "Random Loss", plType: "random",
    iptv: { label: "Random Loss", plType: "random", escalate: true, initialPct: 0, stepPct: 2, ceilingPct: 10,
            minGap: 10, maxGap: 30, minDur: 5, maxDur: 15 } },
];

const HOLD_SEC = 180;        // 3-minute hold / stabilize / clean pre-hold (SLA mode)
const STEP_MS = 50;          // latency ramp step (SLA mode)
const STEP_INTERVAL_SEC = 60; // one step per minute
const TAIL_SEC = 60;         // continue monitoring after ceiling reached

/** Build the ordered case list, resolving each case for the run mode.
 *  tosList: default = full 6×7=42 matrix; a single ToS → 2×7=14. iptv: use the
 *  IPTV spec (explicit steps / fixed holds / periodic+escalating loss). */
function buildMatrix(tosList, iptv) {
  const list = (Array.isArray(tosList) && tosList.length) ? tosList : TOS_LIST;
  const cases = [];
  let n = 0;
  // ToS-outer so each ToS block holds its upstream+downstream, latency+PL cases
  // together (matches "for each ToS, run upstream/downstream").
  for (const tos of list) {
    for (const dir of DIRECTIONS) {
      for (const t of LATENCY_TCS) {
        n++;
        const base = {
          n, id: `${dir.short}_${tos}_${t.tc}`,
          direction: dir.key, dirShort: dir.short, dirLabel: dir.label, tos,
          suite: "latency", suiteLabel: "Latency",
          testcase: t.tc, baseline: !!t.baseline,
        };
        if (iptv) {
          const i = t.iptv || {};
          const steps = i.steps ? (i.steps[dir.key] || []) : null;
          cases.push({ ...base, testLabel: i.label || t.label,
            steps, hold: !!i.hold,
            active: steps && steps.length ? steps[0] : (i.active != null ? i.active : t.active),
            standby: i.standby != null ? i.standby : t.standby, ceiling: null });
        } else {
          cases.push({ ...base, testLabel: t.label,
            active: t.active, standby: t.standby, ceiling: t.ceiling, steps: null, hold: false });
        }
      }
      for (const t of PL_TCS) {
        n++;
        const spec = iptv ? (t.iptv || {}) : t;
        cases.push({
          n, id: `${dir.short}_${tos}_${t.tc}`,
          direction: dir.key, dirShort: dir.short, dirLabel: dir.label, tos,
          suite: "packet-loss", suiteLabel: "Packet Loss",
          testcase: t.tc, testLabel: (iptv && t.iptv && t.iptv.label) || t.label,
          plType: spec.plType || t.plType,
          initialPct: spec.initialPct, stepPct: spec.stepPct, ceilingPct: spec.ceilingPct,
          onSec: spec.onSec, offSec: spec.offSec, escalate: !!spec.escalate, holdSec: spec.holdSec,
          minGap: spec.minGap, maxGap: spec.maxGap, minDur: spec.minDur, maxDur: spec.maxDur,
        });
      }
    }
  }
  return cases;
}

/** Per-case observation window in seconds. IPTV cases end on the first switch,
 *  so these are the ceilings used only when NO switch occurs. */
function caseWindowSec(c, params) {
  const iptv = params && params.iptvMode;
  const FULL = 300; // criteria: full 5-minute observation window when no switch
  let sec;
  if (iptv) {
    // IPTV/orbit mode: one step per minute, whole case ends on switch (after a
    // stabilisation tail) or runs the full 5 minutes. A progression long enough
    // to need >5 min (e.g. a raised --lossmax) extends the window to reach it.
    if (c.suite === "latency") {
      const nSteps = (c.steps && c.steps.length) ? c.steps.length : 0;
      sec = Math.max(nSteps * STEP_INTERVAL_SEC, FULL);
    } else {
      const top = (c.ceilingPct != null ? c.ceilingPct : 10);
      const init = (c.initialPct != null ? c.initialPct : 0);
      const nSteps = Math.ceil((top - init) / (c.stepPct || 2)) + 1;
      sec = Math.max(nSteps * STEP_INTERVAL_SEC, FULL);
    }
  } else if (c.suite === "latency") {
    if (c.baseline) sec = FULL;
    else if (c.steps && c.steps.length) sec = c.steps.length * STEP_INTERVAL_SEC + TAIL_SEC; // explicit sequence
    else if (c.hold) sec = FULL;                                                             // fixed-hold observe
    else {                                                                                   // SLA uniform ramp
      const steps = Math.ceil((c.ceiling - c.active) / STEP_MS);
      sec = HOLD_SEC + steps * STEP_INTERVAL_SEC + TAIL_SEC;
    }
  } else if (c.plType === "constant") {
    const hold = c.holdSec != null ? c.holdSec : HOLD_SEC;
    const steps = Math.ceil((c.ceilingPct - c.initialPct) / c.stepPct);
    sec = hold + steps * STEP_INTERVAL_SEC + TAIL_SEC;
  } else {
    sec = HOLD_SEC + 120; // SLA burst / random
  }
  const cap = parseInt(params && params.caseMaxSec, 10);
  if (cap && cap > 0) sec = Math.min(sec, cap);
  return sec;
}

/**
 * Build the engine `tc` object (schedule driver) for a resolved case.
 * `opts.iptv` adds IPTV-run behaviour: monitor + collect only the direction's
 * DMTS side (upstream→spoke, downstream→hub), end on the first link switch,
 * and collect the hourLog only.
 */
function buildTc(c, opts = {}) {
  const iptv = !!opts.iptv;
  // Criteria: after a switch, let traffic stabilise on the new link BEFORE
  // collecting the DMTS hourLog (do not collect immediately). This is the
  // stabilisation tail the monitor keeps running post-switch; the hourLog is
  // then collected once at case end. Default 60s, override with --stabilize.
  const stabilizeAfterSwitchMs = (opts.stabilizeSec != null ? opts.stabilizeSec : 60) * 1000;
  const iptvFields = iptv
    ? { monitorSide: c.direction === "downstream" ? "hub" : "spoke", endOnSwitch: true,
        hourlogOnly: true, stabilizeAfterSwitchMs }
    : {};
  if (c.suite === "latency") {
    let rampPlan = null;
    if (!c.baseline) {
      if (c.steps && c.steps.length) {
        rampPlan = { initialActiveMs: c.steps[0], standbyMs: c.standby, steps: c.steps,
                     intervalSec: STEP_INTERVAL_SEC, stabilizeSec: 0 };
      } else if (c.hold) {
        rampPlan = { initialActiveMs: c.active, standbyMs: c.standby, hold: true, stabilizeSec: 0 };
      } else {
        rampPlan = { initialActiveMs: c.active, standbyMs: c.standby, stabilizeSec: HOLD_SEC,
                     stepMs: STEP_MS, intervalSec: STEP_INTERVAL_SEC, ceilingMs: c.ceiling };
      }
    }
    return {
      n: c.n, name: c.id, mode: "latency",
      link1: { delayMs: c.active, lossPct: 0 },
      link2: { delayMs: c.standby, lossPct: 0 },
      expectSwitch: !c.baseline, baseline: c.baseline, observeOnly: true,
      rampPlan, ...iptvFields,
    };
  }
  const none = { delayMs: 0, lossPct: 0 };
  let base;
  if (c.plType === "constant") {
    // IPTV/orbit mode: start at initialPct (0%) and observe one interval before
    // ramping (+stepPct/60s). SLA mode keeps its 3-min stabilise hold.
    base = { initialPct: c.initialPct, rampStepPct: c.stepPct, rampIntervalSec: STEP_INTERVAL_SEC,
             stabilizeSec: iptv ? (c.holdSec != null ? c.holdSec : STEP_INTERVAL_SEC) : HOLD_SEC,
             rampMaxPct: c.ceilingPct };
  } else if (c.plType === "periodic") {
    base = { initialPct: c.initialPct, stepPct: c.stepPct, ceilingPct: c.ceilingPct,
             onSec: c.onSec || 20, offSec: c.offSec || 20 };
  } else if (c.plType === "random" && c.escalate) {
    base = { escalate: true, initialPct: c.initialPct, stepPct: c.stepPct, ceilingPct: c.ceilingPct,
             randomMinGapSec: c.minGap || 10, randomMaxGapSec: c.maxGap || 30,
             randomMinDurSec: c.minDur || 5, randomMaxDurSec: c.maxDur || 15 };
  } else if (c.plType === "burst") {
    base = { preHoldSec: iptv ? 0 : HOLD_SEC, burstLossPct: 5, burstDurationSec: 7, burstIntervalSec: 30 };
  } else {
    base = { preHoldSec: iptv ? 0 : HOLD_SEC, randomLossPct: 5,
             randomMinGapSec: 20, randomMaxGapSec: 60, randomMinDurSec: 5, randomMaxDurSec: 15 };
  }
  const plPlan = iptv ? { ...base, endOnSwitch: true } : base;
  return {
    n: c.n, name: c.id, mode: "packet-loss", plType: c.plType,
    link1: none, link2: none, expectSwitch: true, observeOnly: true,
    describe: initialConfig(c), plPlan, ...iptvFields,
  };
}

/* ========================================================================= *
 * Human-readable config strings for the summary table.
 * ========================================================================= */

/** Orbit name (LEO/MEO/GEO) for a latency case, from its test label. */
function orbitLabel(c) {
  const w = (c.testLabel || "").trim().split(/\s+/)[0];
  return /^(LEO|MEO|GEO)$/i.test(w) ? w.toUpperCase() : "Active";
}

function initialConfig(c) {
  if (c.suite === "latency") {
    if (c.baseline) return "Active 0 ms / Standby 0 ms (baseline)";
    if (c.steps && c.steps.length) return `Active ${orbitLabel(c)} ramp [${c.steps.join(", ")}] ms / Standby ${c.standby} ms`;
    if (c.hold) return `Active ${c.active} ms / Standby ${c.standby} ms (fixed hold)`;
    return `Active ${c.active} ms / Standby ${c.standby} ms`;
  }
  if (c.plType === "constant") return `Active ${c.initialPct}% loss, +${c.stepPct}%/min / Standby clean`;
  if (c.plType === "periodic") return `Active periodic ${c.initialPct}→${c.ceilingPct}% (on ${c.onSec || 20}s/off ${c.offSec || 20}s) / Standby clean`;
  if (c.plType === "random") return c.escalate
    ? `Active random ${c.initialPct}→${c.ceilingPct}% / Standby clean`
    : `Active 5% random (gap 20-60s, dur 5-15s) / Standby clean`;
  return `Active 5% burst (7s every 30s) / Standby clean`;
}

function finalConfig(c, r) {
  const sw = r && r.switchObserved;
  if (c.suite === "latency") {
    if (c.baseline) return "No impairment (baseline)";
    if (sw && r.switchLatencyMs != null) return `Active reached ${r.switchLatencyMs} ms at switch`;
    if (sw) return "Switched";
    if (c.steps && c.steps.length) return `Active stepped to ${c.steps[c.steps.length - 1]} ms (no switch)`;
    if (c.hold) return `Held active ${c.active} ms / standby ${c.standby} ms — no switch`;
    return `Active ramped to ceiling ${c.ceiling} ms (no switch)`;
  }
  if (sw) {
    return c.plType === "constant" ? "Switch during loss ramp"
      : c.plType === "periodic" ? "Switch during periodic loss"
        : "Switch during random loss";
  }
  if (c.plType === "constant") return `Reached ${c.ceilingPct}% loss (no switch)`;
  if (c.plType === "periodic") return `Periodic loss reached ${c.ceilingPct}% (no switch)`;
  if (c.plType === "random" && c.escalate) return `Random loss reached ${c.ceilingPct}% (no switch)`;
  return `${c.plType} loss applied for the window (no switch)`;
}

/** Neutral observation string for the Status column — never PASS/FAIL. */
function statusText(r) {
  if (!r) return "not run";
  if (r.result === "ABORTED") return "Aborted";
  let base = r.switchObserved ? "Switch observed" : "No switch";
  if (r.switchObserved && r.switchLatencyMs != null) base = `Switch @ ${r.switchLatencyMs} ms`;
  if (r.errors && r.errors.length) base += " (errors — see logs)";
  return base;
}

function runtimeText(r) {
  if (r && r.startTime && r.endTime) {
    const sec = Math.max(0, Math.round((new Date(r.endTime) - new Date(r.startTime)) / 1000));
    return `${Math.floor(sec / 60)}m ${sec % 60}s`;
  }
  if (r && r.windowSec) return `${Math.floor(r.windowSec / 60)}m ${r.windowSec % 60}s (planned)`;
  return "-";
}

/* ========================================================================= *
 * run_state.json — checkpoint / resume
 * ========================================================================= */

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); }
  catch { return null; }
}

function saveState(state) {
  const tmp = STATE_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_FILE); // atomic replace
}

function clearState() {
  try { fs.unlinkSync(STATE_FILE); } catch { /* already gone */ }
}

/**
 * Summary for the UI resume banner / status endpoint.
 * Returns null if there is no saved state.
 */
function stateSummary() {
  const st = loadState();
  if (!st) return null;
  const matrix = buildMatrix(st.tosList, st.iptvMode);
  const total = st.total || matrix.length;
  const completed = new Set(st.completed || []);
  const next = matrix.find((c) => !completed.has(c.id));
  return {
    exists: true,
    profileName: st.profileName || PROFILE_NAME,
    startedAt: st.startedAt || null,
    total,
    completedCount: completed.size,
    done: completed.size >= total,
    iptvMode: !!st.iptvMode,
    pageId: st.pageId || null,
    pageUrl: st.pageUrl || null,
    resumeFrom: next
      ? { id: next.id, direction: next.dirLabel, tos: next.tos, suite: next.suiteLabel, testcase: `${next.testcase} ${next.testLabel}` }
      : null,
  };
}

/* ========================================================================= *
 * Confluence — ONE shared page. We own the full page body: summary-table rows
 * and detail sections are kept in run_state and the whole body is re-rendered
 * and PUT after each case. This avoids fragile surgery on Confluence-returned
 * storage and makes resume trivial.
 * ========================================================================= */

const AUTOMATION_VERSION = (() => {
  try { return require("./package.json").version || "1.0.0"; }
  catch { return "1.0.0"; }
})();

const e = engine.escapeXml;
const offset = (start, t) => (start && t ? engine.offsetStr(start, t) : "-");

/** Attachment reference macro for an upload name. */
function attRef(name) {
  return `<ac:link><ri:attachment ri:filename="${e(name)}"/></ac:link>`;
}

/** Generic filenames collide across case folders — prefix with the case-id folder. */
const GENERIC = ["observations.txt", "summary.json", "summary.md", "report.html",
  "sla_traffic_client.log", "sla_traffic_server.log"];
function uploadName(f) {
  const b = path.basename(f);
  return GENERIC.includes(b) ? `${path.basename(path.dirname(f))}_${b}` : b;
}
/** Case-scoped upload name: prefix the case id unless the filename already
 *  carries it (hourLog tars do). Guarantees uniqueness on the one shared page
 *  so per-case screenshots/reports don't overwrite each other. */
function caseUploadName(c, f) {
  const b = path.basename(f);
  return b.includes(c.id) ? b : `${c.id}_${b}`;
}

/** Which side's DMTS artifacts to SHOW/upload: upstream→Spoke, downstream→Hub.
 *  (Both sides are still collected locally; only the relevant one is published.) */
function shownSide(c) { return c.direction === "upstream" ? "spoke" : "hub"; }

/** Files uploaded to Confluence for a case: only the relevant side + traffic
 *  logs + reports + screenshots (keeps the page concise). */
function caseUploadFiles(c, r) {
  const seen = new Set();
  return [
    ...(r.artifacts?.[shownSide(c)] || []),
    ...(r.artifacts?.traffic || []),
    ...(r.reportFiles || []),
    ...(r.screenshots || []),
  ].filter((f) => f && !seen.has(f) && seen.add(f));
}

/* ---- link identity helpers (best-effort from DMTS switch data) ---- */
function initialActiveLink(r) {
  return (r.switches && r.switches[0] && r.switches[0].fromLink) || r.activeIface || "auto-detected";
}
function initialStandbyLink(r) {
  return (r.switches && r.switches[0] && r.switches[0].toLink) || "auto-detected";
}
function finalActiveLink(r) {
  if (r.switches && r.switches.length) return r.switches[r.switches.length - 1].toLink;
  return initialActiveLink(r);
}
function finalStandbyLink(r) {
  if (r.switches && r.switches.length) return r.switches[r.switches.length - 1].fromLink;
  return initialStandbyLink(r);
}

/* ---- per-case sub-section builders ---- */

function configurationTable(c, r, baseMeta) {
  const row = (k, v) => `<tr><th>${e(k)}</th><td>${e(v)}</td></tr>`;
  const mins = r.windowSec ? `${Math.round(r.windowSec / 60)} min` : runtimeText(r);
  return (
    `<h4>Configuration</h4><table><tbody>` +
    row("Direction", c.dirLabel) +
    row("ToS", c.tos) +
    row("Traffic", r.trafficType || "UDP") +
    row("Runtime", mins) +
    row("Client", baseMeta.clientHost || "-") +
    row("Server", baseMeta.serverHost || "-") +
    row("Spoke", baseMeta.spokeHost || "-") +
    row("Hub", baseMeta.hubHost || "-") +
    row("Active Link", initialActiveLink(r)) +
    row("Standby Link", initialStandbyLink(r)) +
    `</tbody></table>`
  );
}

function testConfigurationTable(c) {
  const row = (k, v) => `<tr><th>${e(k)}</th><td>${e(v)}</td></tr>`;
  const tbl = (rows) => `<h4>Test Configuration</h4><table><tbody>${rows}</tbody></table>`;
  if (c.suite === "latency") {
    if (c.baseline) {
      return tbl(row("Active Link Delay", "0 ms") + row("Standby Link Delay", "0 ms") +
        row("Hold Time", "5 min (observe)") + row("Increment", "none") + row("Maximum Delay", "0 ms"));
    }
    if (c.steps && c.steps.length) { // explicit orbit ramp sequence
      return tbl(row("Active Link", `${orbitLabel(c)} (ramped)`) +
        row("Latency Sequence", `${c.steps.join(", ")} ms`) +
        row("Standby Link Delay", `${c.standby} ms`) +
        row("Step Interval", "60 s per step (ends on switch)") +
        row("Maximum Delay", `${c.steps[c.steps.length - 1]} ms`));
    }
    if (c.hold) { // fixed hold (LEO-vs-MEO / MEO-vs-GEO)
      return tbl(row("Active Link Delay", `${c.active} ms (fixed)`) +
        row("Standby Link Delay", `${c.standby} ms (fixed)`) +
        row("Hold Time", "5 min (observe)") + row("Increment", "none"));
    }
    return tbl(row("Active Link Delay", `${c.active} ms`) + row("Standby Link Delay", `${c.standby} ms`) +
      row("Hold Time", "3 min") + row("Increment", "50 ms every minute") + row("Maximum Delay", `${c.ceiling} ms`));
  }
  if (c.plType === "constant") {
    return tbl(row("Initial Loss", `${c.initialPct}%`) +
      row("Hold Time", (c.holdSec != null ? c.holdSec : 180) === 0 ? "none (ramp from start)" : "3 min") +
      row("Increment", `${c.stepPct}% every 60 s`) + row("Maximum Loss", `${c.ceilingPct}%`));
  }
  if (c.plType === "periodic") {
    return tbl(row("Pattern", `on ${c.onSec || 20} s / off ${c.offSec || 20} s`) +
      row("Initial Loss", `${c.initialPct}%`) + row("Escalation", `+${c.stepPct}% per cycle`) +
      row("Maximum Loss", `${c.ceilingPct}%`) + row("End", "on first link switch"));
  }
  if (c.plType === "random" && c.escalate) {
    return tbl(row("Pattern", `random gap ${c.minGap || 10}–${c.maxGap || 30} s, dur ${c.minDur || 5}–${c.maxDur || 15} s`) +
      row("Initial Loss", `${c.initialPct}%`) + row("Escalation", `+${c.stepPct}% per event`) +
      row("Maximum Loss", `${c.ceilingPct}%`) + row("End", "on first link switch"));
  }
  if (c.plType === "burst") {
    return tbl(row("Initial Loss", "clean") + row("Hold Time", "3 min (clean)") +
      row("Increment", "5% for 7 s every 30 s") + row("Maximum Loss", "5% (burst)"));
  }
  return tbl(row("Initial Loss", "clean") + row("Hold Time", "3 min (clean)") +
    row("Increment", "5% at random gap 20–60 s, dur 5–15 s") + row("Maximum Loss", "5% (random)"));
}

/** Friendly label for an impairment event string. */
function timelineLabel(ev) {
  const s = ev.event;
  if (/^initial/i.test(s)) return "Impairment Applied";
  if (/standby link/i.test(s)) return "Standby Link Set";
  if (/^ramp/i.test(s)) return `Increment (${s.replace(/^ramp\s*/i, "")})`;
  if (/^burst/i.test(s)) return "Burst Loss Applied";
  if (/^random/i.test(s)) return "Random Loss Applied";
  if (/^clear$/i.test(s)) return "Loss Cleared";
  if (/reached max/i.test(s)) return "Ceiling Reached";
  return s;
}

function executionTimeline(r) {
  const rows = [{ t: "00:00", ev: "Traffic Started" }];
  for (const ev of (r.impairments || [])) rows.push({ t: offset(r.startTime, ev.t), ev: timelineLabel(ev) });
  for (const sw of (r.switches || [])) {
    rows.push({ t: offset(r.startTime, sw.wallClock ?? sw.time), ev: `Traffic Switched (${sw.fromLink} → ${sw.toLink})` });
  }
  if (r.endTime) rows.push({ t: offset(r.startTime, r.endTime), ev: "Traffic Stopped" });
  rows.sort((a, b) => a.t.localeCompare(b.t));
  return `<h4>Execution Timeline</h4><table><tbody><tr><th>Time</th><th>Event</th></tr>` +
    rows.map((x) => `<tr><td>${e(x.t)}</td><td>${e(x.ev)}</td></tr>`).join("") + `</tbody></table>`;
}

function trafficMovementTable(c, r) {
  if (!r.switches || !r.switches.length) {
    return `<h4>Traffic Movement</h4><p>No traffic movement observed during testcase.</p>`;
  }
  const reason = c.suite === "latency"
    ? `active-link latency reached ${r.switchLatencyMs != null ? r.switchLatencyMs + " ms" : "the switch threshold"}`
    : "active-link impairment increased";
  const rows = r.switches.map((sw) =>
    `<tr><td>${e(offset(r.startTime, sw.wallClock ?? sw.time))}</td><td>${e(sw.fromLink)}</td>` +
    `<td>${e(sw.toLink)}</td><td>${e(reason)}</td></tr>`).join("");
  return `<h4>Traffic Movement</h4><table><tbody>` +
    `<tr><th>Time</th><th>From Link</th><th>To Link</th><th>Reason</th></tr>${rows}</tbody></table>`;
}

function impairmentProgression(c, r) {
  const unit = c.suite === "latency" ? "ms" : "%";
  let act = c.suite === "latency" ? c.active : (c.plType === "constant" ? c.initialPct : 0);
  let sb = c.suite === "latency" ? c.standby : 0;
  const rows = [{ t: "00:00", a: act, s: sb }];
  for (const ev of (r.impairments || [])) {
    const m = ev.event.match(/(\d+(?:\.\d+)?)\s*(ms|%)/);
    if (m) { const v = Number(m[1]); if (/standby/i.test(ev.event)) sb = v; else act = v; }
    else if (/^clear$/i.test(ev.event)) act = 0;
    else continue;
    rows.push({ t: offset(r.startTime, ev.t), a: act, s: sb });
  }
  const head = c.suite === "latency"
    ? `<tr><th>Time</th><th>Active Link</th><th>Standby Link</th></tr>`
    : `<tr><th>Time</th><th>Active Link Loss</th><th>Standby Link Loss</th></tr>`;
  return `<h4>Impairment Progression</h4><table><tbody>${head}` +
    rows.map((x) => `<tr><td>${e(x.t)}</td><td>${x.a}${unit}</td><td>${x.s}${unit}</td></tr>`).join("") +
    `</tbody></table>`;
}

/** Find the local file matching a name test within a list. */
function findFile(files, test) { return (files || []).find((f) => test(path.basename(f).toLowerCase())); }

function logCollectionTables(c, r) {
  const side = shownSide(c);
  const sideLabel = side === "spoke" ? "Spoke" : "Hub";
  const dirLabel = c.direction === "upstream" ? "Upstream" : "Downstream";
  const dmts = r.artifacts?.[side] || [];
  const reports = r.reportFiles || [];
  const rowFor = (label, file) =>
    `<tr><td>${e(label)}</td><td>${file ? "&#10003;" : "&#10007;"}</td>` +
    `<td>${file ? attRef(uploadName(file)) : "-"}</td></tr>`;
  const items = [
    ["hourLog", findFile(dmts, (f) => f.includes("hourlog"))],
    ["curLog", findFile(dmts, (f) => f.includes("curlog"))],
    ["ubd", findFile(dmts, (f) => f.includes("_ubd.tar"))],
    ["ubdLatest.tar", findFile(dmts, (f) => f.includes("ubdlatest"))],
    ["Diag Pack", findFile(dmts, (f) => f.includes("diagpack"))],
    ["HTML Report", findFile(reports, (f) => f.endsWith("report.html"))],
    ["observations.txt", findFile(reports, (f) => f.endsWith("observations.txt")) || r.observationsFile],
    ["summary.json", findFile(reports, (f) => f.endsWith("summary.json"))],
  ];
  const dmtsTable =
    `<h4>Log Collection — ${dirLabel} (${sideLabel})</h4>` +
    `<table><tbody><tr><th>Artifact</th><th>Status</th><th>Attachment</th></tr>` +
    items.map(([l, f]) => rowFor(l, f)).join("") + `</tbody></table>`;

  const traffic = r.artifacts?.traffic || [];
  const clientLog = findFile(traffic, (f) => f.includes("client"));
  const serverLog = findFile(traffic, (f) => f.includes("server"));
  const trafficTable =
    `<h5>Traffic Logs</h5><table><tbody><tr><th>Artifact</th><th>Attachment</th></tr>` +
    `<tr><td>Client iperf Log</td><td>${clientLog ? attRef(uploadName(clientLog)) : "-"}</td></tr>` +
    `<tr><td>Server iperf Log</td><td>${serverLog ? attRef(uploadName(serverLog)) : "-"}</td></tr>` +
    `</tbody></table>`;
  return dmtsTable + trafficTable;
}

function observationsList(c, r) {
  const items = [];
  if (r.trafficVerifiedBps != null) items.push("Traffic started successfully.");
  else if (r.errors && r.errors.some((x) => /traffic/i.test(x))) items.push("Traffic did not verify — see errors.");
  if (c.suite === "latency" && !c.baseline) items.push(`${c.testLabel} latency (${c.active} ms) applied on the active link.`);
  else if (c.suite === "latency") items.push("Baseline — no impairment applied.");
  else if (c.plType === "constant") items.push(`Constant packet loss (${c.initialPct}%) applied on the active link.`);
  else if (c.plType === "burst") items.push("Burst packet loss (5% for 7 s every 30 s) applied on the active link.");
  else items.push("Random packet loss applied on the active link.");
  if (r.switchObserved && r.switches.length) {
    const sw = r.switches[r.switches.length - 1];
    items.push(c.suite === "latency" && r.switchLatencyMs != null
      ? `Traffic switched to ${sw.toLink} after latency reached ${r.switchLatencyMs} ms.`
      : `Traffic switched to ${sw.toLink}.`);
    items.push("Hourlog collected immediately after switch.");
  } else {
    items.push("No traffic switch observed during the testcase.");
  }
  items.push("Reports generated successfully.");
  items.push("Artifacts uploaded to Confluence.");
  if (r.errors && r.errors.length) items.push(`Errors: ${r.errors.join(" | ")}`);
  return `<h4>Observations</h4><ul>` + items.map((x) => `<li>${e(x)}</li>`).join("") + `</ul>`;
}

function commandsSection(r) {
  const rows = [];
  if (r.serverCmd) rows.push(["iperf3 server", r.serverCmd]);
  if (r.clientCmd) rows.push(["iperf3 client", r.clientCmd]);
  if (!rows.length) return "";
  return `<h4>Commands</h4><table><tbody>` +
    rows.map(([k, v]) => `<tr><th>${e(k)}</th><td><code>${e(v)}</code></td></tr>`).join("") +
    `</tbody></table>` +
    `<p style="font-size:11px;color:#64748b">Netem impairment applied via <code>tc</code> on the netem VM overlay ports — the exact per-step values are in Impairment Progression above.</p>`;
}

function screenshotsBlock(r) {
  const shots = (r.screenshots || []).slice().sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
  if (!shots.length) return "";
  const caption = (name) =>
    name.includes("01_before") ? "Before impairment"
      : name.includes("02_after") ? "After impairment"
        : name.includes("03_switch") ? "During traffic switch"
          : name.includes("04_test_complete") ? "End of testcase"
            : name.includes("99_") ? "Traffic not flowing" : name;
  return `<h4>Screenshots</h4>` + shots.map((p) => {
    const b = path.basename(p);
    return `<p><strong>${e(caption(b))}</strong><br/>` +
      `<ac:image ac:width="480"><ri:attachment ri:filename="${e(b)}"/></ac:image></p>`;
  }).join("");
}

function resultTable(c, r) {
  const row = (k, v) => `<tr><th>${e(k)}</th><td>${e(v)}</td></tr>`;
  return `<h4>Result</h4><table><tbody>` +
    row("Traffic Switch", r.switchObserved ? "Yes" : "No") +
    row("Switch Time", r.switchAt || (r.switches && r.switches[0] && r.switches[0].time) || "-") +
    row("Final Active Link", finalActiveLink(r)) +
    row("Final Standby Link", finalStandbyLink(r)) +
    row("Automation Completed", "Yes") +
    `</tbody></table>`;
}

/* ========================================================================= *
 * Confluence page — IPTV Testing page STYLE: one table with columns
 * Testcase | Logs | Commands | Results, one row appended per testcase.
 * ========================================================================= */

const IPTV_HEADER =
  "<tr>" + ["S.No", "Testcase", "Logs", "Commands", "Results"].map((h) => `<th>${h}</th>`).join("") + "</tr>";

/** Column 1 — Testcase: traffic type / direction / suite+TC / ToS / config. */
function tcCell(c, r) {
  const dir = c.direction === "downstream" ? "downstream" : "upstream";
  return `<strong>Traffic type: IPTV ${dir}</strong><br/>` +
    `${e(c.suiteLabel)} — ${e(c.testcase)} ${e(c.testLabel)}<br/>` +
    `ToS ${e(c.tos)}<br/>` +
    `${e(initialConfig(c))}<br/>` +
    `Runtime: ${e(runtimeText(r))}`;
}

/** Column 2 — Logs: direction-scoped DMTS hourLog + screenshots + reports. */
function logsCell(c, r) {
  const side = shownSide(c);
  const sideLabel = side === "spoke" ? "Spoke" : "Hub";
  const parts = [];
  const hourlog = findFile(r.artifacts && r.artifacts[side], (f) => f.includes("hourlog"));
  parts.push(`DMTS hourLog (${sideLabel}): ${hourlog ? attRef(caseUploadName(c, hourlog)) : "&mdash;"}`);
  const shots = r.screenshots || [];
  if (shots.length) parts.push(`Screenshots: ` + shots.map((p) => attRef(caseUploadName(c, p))).join(" "));
  const report = findFile(r.reportFiles, (f) => f.endsWith("report.html"));
  if (report) parts.push(`HTML report: ${attRef(caseUploadName(c, report))}`);
  const obs = findFile(r.reportFiles, (f) => f.endsWith("observations.txt")) || r.observationsFile;
  if (obs) parts.push(`observations.txt: ${attRef(caseUploadName(c, obs))}`);
  const sum = findFile(r.reportFiles, (f) => f.endsWith("summary.json"));
  if (sum) parts.push(`summary.json: ${attRef(caseUploadName(c, sum))}`);
  return parts.join("<br/>");
}

/** Column 3 — Commands: iperf3 server/client + the netem tc actions (per step). */
function commandsCell(c, r) {
  const lines = [];
  if (r.serverCmd) lines.push(`<strong>iperf3 server:</strong><br/><code>${e(r.serverCmd)}</code>`);
  if (r.clientCmd) lines.push(`<strong>iperf3 client:</strong><br/><code>${e(r.clientCmd)}</code>`);
  const imp = r.impairments || [];
  if (imp.length) {
    const steps = imp.map((ev) => `${e(offset(r.startTime, ev.t))} ${e(ev.event)}`).join("<br/>");
    lines.push(`<strong>Netem (tc):</strong><br/>${steps}`);
  } else if (c.baseline) {
    lines.push(`<strong>Netem (tc):</strong> none (baseline)`);
  }
  return lines.join("<br/><br/>");
}

/** Column 4 — Results: observation prose in the reference-page style (no PASS/FAIL). */
function resultsCell(c, r) {
  const bits = [];
  const nMin = r.windowSec ? Math.round(r.windowSec / 60)
    : (r.startTime && r.endTime ? Math.round((new Date(r.endTime) - new Date(r.startTime)) / 60000) : 5);
  if (r.switchObserved && r.switches && r.switches.length) {
    const sw = r.switches[r.switches.length - 1];
    const when = r.switchAt || sw.time;
    let why = "";
    if (c.suite === "latency" && r.switchLatencyMs != null) why = ` when active-link latency reached ${r.switchLatencyMs} ms`;
    else if (c.suite === "packet-loss") why = r.switchLatencyMs != null
      ? ` when induced packet loss reached ${r.switchLatencyMs}%`
      : ` when induced packet loss reached the switch threshold`;
    bits.push(`Traffic switched from ${e(sw.fromLink)} to ${e(sw.toLink)} at ${e(when)}${why}.`);
    if (sw.fromLinkLatency95P != null || sw.fromLinkPacketLoss95P != null) {
      bits.push(`At switch: from-link latency95P ${e(sw.fromLinkLatency95P)} ms, packetLoss95P ${e(sw.fromLinkPacketLoss95P)}%.`);
    }
    // Criteria: hourLog captured only after traffic stabilised on the new link.
    if (r.stabilizeSec) bits.push(`Traffic allowed to stabilise ${r.stabilizeSec}s on the new link before the DMTS hourLog was captured.`);
    bits.push(`Final active link: ${e(finalActiveLink(r))}.`);
  } else {
    bits.push(`No load balancing observed. Traffic remained on the same link throughout the ${nMin}-minute test.`);
    bits.push(`Final active link: ${e(finalActiveLink(r))}.`);
  }
  bits.push(`Final configuration: ${e(finalConfig(c, r))}.`);
  if (r.errors && r.errors.length) bits.push(`Errors: ${e(r.errors.join(" | "))}.`);
  bits.push(`<em>Automation completed — observation only (no PASS/FAIL).</em>`);
  return bits.join("<br/>");
}

/** One IPTV-style table row for a completed case. */
function iptvRow(c, r) {
  return `<tr><td>${c.n}</td><td>${tcCell(c, r)}</td><td>${logsCell(c, r)}</td>` +
    `<td>${commandsCell(c, r)}</td><td>${resultsCell(c, r)}</td></tr>`;
}

function buildPageBody(state, baseMeta) {
  const date = (state.startedAt || "").slice(0, 10) || "unknown-date";
  const done = (state.completed || []).length;
  const total = state.total || TOTAL;
  const rows = (state.summaryRows || []).join("");
  const meta =
    `<p><strong>Execution ID:</strong> ${e(state.runId)} &nbsp;|&nbsp; ` +
    `<strong>ToS:</strong> ${e((state.tosList && state.tosList.join(", ")) || "0x04, 0x24, 0x38")} &nbsp;|&nbsp; ` +
    `<strong>Grid:</strong> ${e(baseMeta.gridVersion)} &nbsp;|&nbsp; ` +
    `<strong>Progress:</strong> ${done}/${total} &nbsp;|&nbsp; ` +
    `<strong>Spoke / Hub:</strong> ${e(baseMeta.spokeHost)} / ${e(baseMeta.hubHost)}</p>`;
  return (
    `<h1>SLA Regression Report - ${e(date)}</h1>` +
    `<p><em>Observations only — no PASS/FAIL. Manual validation to follow.</em></p>` +
    meta +
    `<table><tbody>${IPTV_HEADER}${rows || ""}</tbody></table>`
  );
}

/** Create the shared page once (fresh run), or reuse the stored id (resume). */
async function ensurePage(conf, state, baseMeta, parentCandidate) {
  await engine.resolveConfApiBase(conf);
  if (state.pageId) { conf.pageId = state.pageId; return state.pageId; }

  // Determine a space to create in: explicit space wins; otherwise derive it
  // from the parent page the operator pointed at.
  let space = conf.space;
  let ancestors = [];
  if (parentCandidate) {
    ancestors = [{ id: String(parentCandidate) }];
    if (!space) {
      try {
        const resp = await engine.confFetch(conf,
          `${engine.confApiBase(conf)}/rest/api/content/${parentCandidate}?expand=space`, {}, "get parent space");
        if (resp.ok) space = (await resp.json()).space?.key || null;
      } catch { /* fall through — will error clearly below */ }
    }
  }
  if (!space) throw new Error("Confluence: provide a Space key, or a Page URL/ID to create the regression page under");

  const title = `SLA Regression Report - ${state.startedAt.slice(0, 10)} (${state.runId})`;
  const payload = {
    type: "page", title, space: { key: space },
    ...(ancestors.length ? { ancestors } : {}),
    body: { storage: { value: buildPageBody(state, baseMeta), representation: "storage" } },
  };
  const resp = await engine.confFetch(conf, `${engine.confApiBase(conf)}/rest/api/content`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
  }, "create regression page");
  if (!resp.ok) throw new Error(`create page: HTTP ${resp.status} ${(await resp.text()).slice(0, 300)}`);
  const created = await resp.json();
  state.pageId = created.id;
  state.pageTitle = title;
  state.pageUrl = created._links && created._links.base && created._links.webui
    ? created._links.base + created._links.webui : null;
  conf.pageId = created.id;
  engine.setStatus({ confluence: `page ${created.id} created` });
  return created.id;
}

/** Re-render the whole page body and PUT it (version+1). */
async function putPage(conf, state, baseMeta) {
  const getResp = await engine.confFetch(conf,
    `${engine.confApiBase(conf)}/rest/api/content/${state.pageId}?expand=version`, {}, "get page version");
  if (!getResp.ok) throw new Error(`get page ${state.pageId}: HTTP ${getResp.status}`);
  const page = await getResp.json();
  const payload = {
    id: state.pageId, type: "page", title: state.pageTitle || page.title,
    version: { number: page.version.number + 1, message: "SLA regression: append test case" },
    body: { storage: { value: buildPageBody(state, baseMeta), representation: "storage" } },
  };
  const putResp = await engine.confFetch(conf, `${engine.confApiBase(conf)}/rest/api/content/${state.pageId}`, {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
  }, "update regression page");
  if (!putResp.ok) throw new Error(`update page: HTTP ${putResp.status} ${(await putResp.text()).slice(0, 300)}`);
}

/** Append one completed case to the shared page: attachments, row, section, PUT. */
async function appendCase(conf, state, baseMeta, c, r) {
  // upload only the shown side + traffic + reports + screenshots so the
  // row/section attachment links resolve (other side stays local only)
  for (const f of caseUploadFiles(c, r)) {
    try { await engine.confUploadAttachment(conf, state.pageId, f, caseUploadName(c, f)); }
    catch (err) { engine.log(`WARN: attach ${path.basename(f)}: ${err.message}`); }
  }
  state.summaryRows = state.summaryRows || [];
  state.summaryRows.push(iptvRow(c, r)); // one Testcase|Logs|Commands|Results row
  await putPage(conf, state, baseMeta);
}

/* ========================================================================= *
 * Orchestrator
 * ========================================================================= */

/**
 * Run (or resume) the full 42-case regression.
 * @param cfg    engine config (engine.buildConfig(params))
 * @param params raw params (needs trafficType, bandwidth, caseMaxSec?, confluence)
 * @param opts   { resume: boolean }
 */
async function runRegression(cfg, params, opts = {}) {
  const log = (m) => engine.log(m); // streams to automation.log + the UI SSE

  // Force the regression-safe drivers regardless of what the form carried.
  cfg.trafficDriver = "ssh";
  cfg.impairmentDriver = "ssh-tc";
  if (!cfg.netemCandidates || !cfg.netemCandidates.length) {
    cfg.netemCandidates = ["ens192", "ens193", "ens224", "ens225"];
  }

  // ---- state: load FIRST so a resume drives mode/ToS from the SAVED run, not
  // from whatever flags this invocation happens to carry. ----
  let state = opts.resume ? loadState() : null;
  let iptvMode, tosList;
  if (state) {
    // resume: authoritative values come from the saved state
    iptvMode = !!state.iptvMode;
    tosList = (Array.isArray(state.tosList) && state.tosList.length) ? state.tosList : TOS_LIST.slice();
  } else {
    // fresh run: derive from params
    iptvMode = !!(params && params.iptvMode);
    tosList = params && params.regressionTosList;
    if (typeof tosList === "string") tosList = tosList.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
    if (!Array.isArray(tosList) || !tosList.length) tosList = TOS_LIST.slice();
  }
  let matrix = buildMatrix(tosList, iptvMode);
  // --only <ids>: run just those cases as a self-contained set (keeps each
  // case's real S.No; total reflects the subset). Used for targeted re-runs.
  if (opts.only && opts.only.size) matrix = matrix.filter((c) => opts.only.has(c.id));
  // Optional PL loss-ceiling override (e.g. --lossmax=15): cap every packet-loss
  // case's escalation ceiling so no case applies more than N% loss.
  const lossCap = parseInt(params && params.iptvLossCeiling, 10);
  if (lossCap > 0) {
    for (const c of matrix) if (c.suite === "packet-loss" && c.ceilingPct != null) {
      c.ceilingPct = Math.min(c.ceilingPct, lossCap);
    }
  }

  if (!state) {
    state = {
      runId: `sla-reg-${new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14)}`,
      startedAt: new Date().toISOString(),
      profileName: iptvMode ? "SLA Regression — IPTV" : PROFILE_NAME,
      currentIndex: 0,
      total: matrix.length,
      tosList, iptvMode,
      pageId: null, pageTitle: null, pageUrl: null,
      completed: [],
      summaryRows: [], sections: [],
      cases: [],
    };
    saveState(state);
  }
  // back-fill fields missing from older state files
  if (!state.tosList) state.tosList = tosList;
  if (state.iptvMode == null) state.iptvMode = iptvMode;
  if (!state.total) state.total = matrix.length;
  if (!Array.isArray(state.cases)) state.cases = [];
  if (!Array.isArray(state.summaryRows)) state.summaryRows = [];
  const total = state.total;
  const completed = new Set(state.completed || []);

  engine.clearAbort();
  engine.resetRunLogs();
  engine.setStatus({ phase: "running", caseCount: total, caseIndex: completed.size, mode: "regression" });

  // ---- infrastructure once ----
  await engine.preflight(cfg);
  if (cfg.netemSsh && (cfg.netemSsh.pass || cfg.netemSsh.keyPath)) await engine.sanitizeNetem(cfg);

  const baseMeta = await engine.collectRunMetadata(cfg, params.trafficType, "-", "-");
  baseMeta.clientHost = cfg.clientIp || (params && params.clientIp) || "-";
  baseMeta.serverHost = cfg.serverIp || (params && params.serverIp) || "-";

  // ---- Confluence page (create once / reuse) ----
  const conf = cfg.confluence;
  if (conf) {
    // A form Page URL/ID acts as the PARENT to create our fresh page under.
    const parentCandidate = conf.parentId || conf.pageId || null;
    if (!opts.resume) conf.pageId = null; // fresh run always creates a new page
    try {
      await ensurePage(conf, state, baseMeta, parentCandidate);
      saveState(state);
    } catch (e) {
      engine.setStatus({ confluence: `FAILED: ${e.message}` });
      console.error(`Confluence page setup failed: ${e.message}`);
      throw e; // without a page there is nowhere to publish — abort early
    }
  }

  // ---- browser (screenshots only; optional) ----
  let browser = null, page = null;
  try { ({ browser, page } = await engine.openNetemUi(cfg)); }
  catch (e) { console.log(`WARN: netem UI page unavailable for screenshots (${(e.message || "").split("\n")[0]}) — continuing`); }

  const uiResults = [];
  let ranThisRun = 0; // for opts.limit (smoke tests)
  try {
    for (const c of matrix) {
      if (engine.isAborted()) { log("regression aborted by user — stopping"); break; }
      if (opts.only && !opts.only.has(c.id)) continue; // smoke: run only selected case ids
      if (completed.has(c.id)) { log(`skip ${c.id} — already completed`); continue; }
      if (opts.limit && ranThisRun >= opts.limit) { log(`reached --limit ${opts.limit} — stopping (smoke run)`); break; }

      state.currentIndex = c.n;
      engine.setStatus({ caseIndex: c.n, currentCase: c.id });
      log(`########## CASE ${c.n}/${total} — ${c.id} (${c.suiteLabel} ${c.testcase}) ##########`);

      const tc = buildTc(c, { iptv: state.iptvMode, stabilizeSec: params.iptvStabilizeSec });
      const durationMs = (params.forceCaseSec ? parseInt(params.forceCaseSec, 10) : caseWindowSec(c, params)) * 1000;
      const caseDir = path.join(BASE_DIR, `${c.dirShort}_${c.tos}`, c.suite);
      fs.mkdirSync(caseDir, { recursive: true });

      // CLEAN SLATE: mandatory reset gate before every case so no case inherits
      // the previous case's traffic or impairment. Stops iperf on both hosts,
      // clears all latency+loss on every overlay port back to 0ms/0%, verifies
      // the active link, and settles briefly. Belt-and-suspenders on top of
      // runTestCase's own teardown — a crashed/interrupted case still leaves the
      // next one a known-clean baseline.
      await engine.resetLabBetweenCases(cfg, {
        settleSec: params.iptvResetSettleSec != null ? params.iptvResetSettleSec : 3,
        label: c.id,
      });

      // IPTV mode traffic pattern (operator-specified), per direction:
      //   upstream (spoke):   iperf3 -u -c 10.40.2.2 -p 5201 -b 3M -l 1200 -P 10  (30 Mbps)
      //   downstream (hub):   iperf3 -u -c 10.40.2.2 -p 5201 -b 6M -l 1200 -P 10  (60 Mbps)
      // 1200-byte packets to the overlay data-plane IP; -S <tos> per case.
      // Overridable via iptvBwUp/iptvBwDown/iptvFlows/iptvPktLen/iptvServerIp/iptvPort.
      const caseBw = state.iptvMode
        ? (c.direction === "downstream" ? (params.iptvBwDown || "6M") : (params.iptvBwUp || "3M"))
        : params.bandwidth;
      const caseStreams = state.iptvMode ? (params.iptvFlows || "10") : params.parallelStreams;
      const caseServerIp = state.iptvMode
        ? (params.iptvServerIp || params.serverTrafficIp || "10.40.2.2")
        : (params.serverTrafficIp || params.serverIp);
      const casePort = state.iptvMode ? (params.iptvPort || "5201") : params.serverPort;
      const casePkt = state.iptvMode ? (params.iptvPktLen || "1200") : params.packetSize;
      const cmds = engine.buildTrafficCommands({
        ...params, trafficDirection: c.direction, tos: c.tos,
        bandwidth: caseBw, parallelStreams: caseStreams, serverTrafficIp: caseServerIp,
        serverPort: casePort, packetSize: casePkt,
      });
      const traffic = {
        type: String(params.trafficType || "UDP").toUpperCase(),
        direction: c.direction,
        tos: engine.parseTos(c.tos),
        bandwidth: engine.parseBandwidth(caseBw).value,
        serverCmd: cmds.serverCmd || null,
        clientCmd: cmds.clientCmd || null,
      };

      const caseMeta = { ...baseMeta, direction: c.direction, trafficType: traffic.type, tos: traffic.tos };
      let r;
      try {
        r = await engine.runTestCase(cfg, browser, page, tc, traffic, caseDir, durationMs);
      } catch (e) {
        log(`ERROR: case ${c.id} failed: ${e.message}`);
        r = {
          tc: c.n, name: c.id, mode: c.suite, link1: tc.link1, link2: tc.link2,
          trafficType: traffic.type, tos: traffic.tos, direction: c.direction,
          startTime: null, endTime: null, switches: [], switchObserved: false,
          artifacts: { spoke: [], hub: [], traffic: [] }, screenshots: [],
          errors: [e.message], result: "OBSERVED", windowSec: Math.round(durationMs / 1000),
        };
      }

      // ---- reports for this case (per-case dir = caseDir/<id>, matching the
      // tcDir runTestCase used for observations.txt, so combos don't collide) ----
      try {
        const tcDir = path.join(caseDir, c.id);
        fs.mkdirSync(tcDir, { recursive: true });
        const html = engine.writeHtmlReport(tcDir, [r], caseMeta);
        engine.writeSummary(tcDir, [r], caseMeta);
        r.reportFiles = [html, path.join(tcDir, "summary.json")];
        if (r.observationsFile) r.reportFiles.push(r.observationsFile);
      } catch (e) { log(`WARN: report generation ${c.id}: ${e.message}`); r.reportFiles = r.reportFiles || []; }

      // ---- checkpoint (mark complete BEFORE the Confluence render so the page's
      // Execution Summary / Suite Completion counts include this case) ----
      completed.add(c.id);
      state.completed = [...completed];
      const caseRec = {
        id: c.id, direction: c.direction, tos: c.tos, suite: c.suiteLabel, testcase: c.testcase,
        status: statusText(r), startTime: r.startTime, endTime: r.endTime,
        uploaded: false, logsCollected: !!(r.artifacts && (r.artifacts.spoke.length || r.artifacts.hub.length)),
        reportsGenerated: !!(r.reportFiles && r.reportFiles.length),
        switchObserved: !!r.switchObserved, switchTime: r.switchAt || null,
        initialConfig: initialConfig(c), finalConfig: finalConfig(c, r),
      };
      state.cases.push(caseRec);

      // ---- Confluence append (immediately) ----
      if (conf) {
        engine.setStatus({ confluence: `appending ${c.id}` });
        try { await appendCase(conf, state, baseMeta, c, r); caseRec.uploaded = true; engine.setStatus({ confluence: `appended ${c.id}` }); }
        catch (e) { engine.setStatus({ confluence: `append FAILED: ${e.message}` }); log(`ERROR: Confluence append ${c.id}: ${e.message}`); }
      }

      saveState(state);
      uiResults.push({ name: c.id, result: r.result || "OBSERVED" });
      engine.setStatus({ results: uiResults.slice() });
      ranThisRun++;
      log(`CASE ${c.n}/${total} ${c.id} DONE — ${statusText(r)}${caseRec.uploaded ? " — uploaded" : ""}`);
    }
  } finally {
    if (browser) { try { await browser.close(); } catch { /* ignore */ } }
    if (engine.activeImpairments && engine.activeImpairments.size) {
      for (const iface of [...engine.activeImpairments]) {
        try { await engine.clearNetemImpairment(cfg, iface); } catch (e) { log(`WARN: leftover netem ${iface}: ${e.message}`); }
      }
    }
  }

  const aborted = engine.isAborted();
  const done = (state.completed || []).length;
  engine.setStatus({ phase: aborted ? "aborted" : "done", confluence: state.pageId ? `page ${state.pageId}` : "n/a" });
  engine.clearAbort();
  log(`=== REGRESSION ${aborted ? "ABORTED" : "COMPLETE"} — ${done}/${total} cases — page ${state.pageId || "(none)"} ===`);
  return { pageId: state.pageId, completed: done, total, state, aborted };
}

/* ========================================================================= *
 * CLI entry
 * ========================================================================= */

async function main() {
  const args = process.argv.slice(2);
  const resume = args.includes("--resume");
  const restart = args.includes("--restart");
  if (restart) { clearState(); console.log("run_state.json cleared — starting fresh"); }

  const profiles = (() => {
    try { return JSON.parse(fs.readFileSync(path.join(__dirname, "profiles.json"), "utf8")); }
    catch { return {}; }
  })();
  const params = profiles.__default__;
  if (!params) { console.error("no saved profile (profiles.json __default__) — open the panel and Start once, or fill profiles.json"); process.exit(1); }
  // Confluence is optional: on by default, --no-confluence runs local-only
  // (hourLogs + reports still land under SLA_Regression/).
  params.confluence = !args.includes("--no-confluence");
  // CLI: --iptv enables IPTV mode; --tos=0x04[,0x24] restricts the ToS set.
  if (args.includes("--iptv")) params.iptvMode = true;
  const tosArg = args.find((a) => a.startsWith("--tos="));
  if (tosArg) params.regressionTosList = tosArg.slice("--tos=".length);
  const maxArg = args.find((a) => a.startsWith("--max="));   // per-case window cap (s)
  if (maxArg) params.caseMaxSec = maxArg.slice("--max=".length);
  const lossArg = args.find((a) => a.startsWith("--lossmax=")); // cap PL escalation ceiling (%)
  if (lossArg) params.iptvLossCeiling = parseInt(lossArg.slice("--lossmax=".length), 10);
  const winArg = args.find((a) => a.startsWith("--win="));   // force exact per-case window (s)
  if (winArg) params.forceCaseSec = parseInt(winArg.slice("--win=".length), 10);
  const stabArg = args.find((a) => a.startsWith("--stabilize=")); // post-switch stabilise before hourLog (s)
  if (stabArg) params.iptvStabilizeSec = parseInt(stabArg.slice("--stabilize=".length), 10);
  const limitArg = args.find((a) => a.startsWith("--limit=")); // run only N cases (smoke)
  const limit = limitArg ? parseInt(limitArg.slice("--limit=".length), 10) : undefined;
  const onlyArg = args.find((a) => a.startsWith("--only=")); // run only these case ids (smoke)
  const only = onlyArg ? new Set(onlyArg.slice("--only=".length).split(/[,\s]+/).filter(Boolean)) : undefined;

  const check = engine.validateParams(params);
  if (!check.ok) { console.error(`invalid params: ${JSON.stringify(check.errors)}`); process.exit(1); }
  const cfg = engine.buildConfig(params);

  const summary = stateSummary();
  if (summary && !summary.done && !resume && !restart) {
    console.log(`\nPrevious SLA Regression found — completed ${summary.completedCount}/${summary.total}.`);
    console.log(`Resume from: ${summary.resumeFrom ? `${summary.resumeFrom.direction} · ToS ${summary.resumeFrom.tos} · ${summary.resumeFrom.suite} ${summary.resumeFrom.testcase}` : "(end)"}`);
    console.log(`Run with --resume to continue, or --restart to start over.\n`);
    process.exit(0);
  }

  const res = await runRegression(cfg, params, { resume: resume && !restart, limit, only });
  process.exit(res.completed >= res.total ? 0 : 1);
}

if (require.main === module) {
  main().catch((e) => { console.error("REGRESSION FATAL:", e.stack || e.message); process.exit(1); });
}

module.exports = {
  runRegression, buildMatrix, caseWindowSec, buildTc,
  loadState, saveState, clearState, stateSummary,
  initialConfig, finalConfig, statusText,
  buildPageBody, iptvRow, ensurePage, appendCase,
  PROFILE_NAME, STATE_FILE, TOTAL,
};
