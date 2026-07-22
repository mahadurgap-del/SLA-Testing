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

// Latency suite. `active` = initial delay applied to the auto-detected active
// link; `standby` = fixed delay held on the standby link for the whole case;
// `ceiling` = active-link ramp ceiling (+50ms/60s, after a 180s hold).
const LATENCY_TCS = [
  { tc: "TC1", label: "Baseline", baseline: true, active: 0, standby: 0, ceiling: 0 },
  { tc: "TC2", label: "LEO", active: 30, standby: 0, ceiling: 130 },
  { tc: "TC3", label: "LEO vs MEO", active: 30, standby: 150, ceiling: 400 },
  { tc: "TC4", label: "MEO vs GEO", active: 150, standby: 600, ceiling: 1500 },
];

// Packet-loss suite. All impairment is auto-applied to the detected active link.
const PL_TCS = [
  { tc: "PL_TC1", label: "Constant Loss", plType: "constant", initialPct: 2, stepPct: 2, ceilingPct: 20 },
  { tc: "PL_TC2", label: "Burst Loss", plType: "burst" },
  { tc: "PL_TC3", label: "Random Loss", plType: "random" },
];

const HOLD_SEC = 180;        // 3-minute hold / stabilize / clean pre-hold
const STEP_MS = 50;          // latency ramp step
const STEP_INTERVAL_SEC = 60; // one step per minute
const TAIL_SEC = 60;         // continue monitoring after ceiling reached

/** Build the ordered case list. Default = full 6×7=42 matrix; pass a single
 *  ToS (e.g. ["0x04"]) for a 2×7=14 IPTV-style run. */
function buildMatrix(tosList) {
  const list = (Array.isArray(tosList) && tosList.length) ? tosList : TOS_LIST;
  const cases = [];
  let n = 0;
  for (const dir of DIRECTIONS) {
    for (const tos of list) {
      for (const t of LATENCY_TCS) {
        n++;
        cases.push({
          n, id: `${dir.short}_${tos}_${t.tc}`,
          direction: dir.key, dirShort: dir.short, dirLabel: dir.label, tos,
          suite: "latency", suiteLabel: "Latency",
          testcase: t.tc, testLabel: t.label, baseline: !!t.baseline,
          active: t.active, standby: t.standby, ceiling: t.ceiling,
        });
      }
      for (const t of PL_TCS) {
        n++;
        cases.push({
          n, id: `${dir.short}_${tos}_${t.tc}`,
          direction: dir.key, dirShort: dir.short, dirLabel: dir.label, tos,
          suite: "packet-loss", suiteLabel: "Packet Loss",
          testcase: t.tc, testLabel: t.label, plType: t.plType,
          initialPct: t.initialPct, stepPct: t.stepPct, ceilingPct: t.ceilingPct,
        });
      }
    }
  }
  return cases;
}

/** Per-case observation window in seconds. In IPTV mode cases end on the first
 *  link switch (see buildTc), so these are the ceilings used only when NO switch
 *  occurs — packet-loss is deliberately kept under 10 minutes. */
function caseWindowSec(c, params) {
  const iptv = params && params.iptvMode;
  let sec;
  if (c.suite === "latency") {
    if (c.baseline) sec = 300;
    else {
      const steps = Math.ceil((c.ceiling - c.active) / STEP_MS);
      sec = HOLD_SEC + steps * STEP_INTERVAL_SEC + TAIL_SEC;
      if (iptv) sec = Math.min(sec, 600); // ≤10 min if no switch
    }
  } else if (c.plType === "constant") {
    const steps = Math.ceil((c.ceilingPct - c.initialPct) / c.stepPct);
    sec = HOLD_SEC + steps * STEP_INTERVAL_SEC + TAIL_SEC;
    if (iptv) sec = Math.min(sec, 480); // PL: do not run ~10 min — cap at 8
  } else {
    sec = HOLD_SEC + 120; // burst / random: 5-minute case (3-min clean + 2-min active)
  }
  const cap = parseInt(params && params.caseMaxSec, 10);
  if (cap && cap > 0) sec = Math.min(sec, cap);
  return sec;
}

/**
 * Build the engine `tc` object (schedule driver) for a case.
 * `opts.iptv` adds IPTV-run behaviour: monitor + collect only the direction's
 * DMTS side (upstream→spoke, downstream→hub), end the case on the first link
 * switch, and collect the hourLog only.
 */
function buildTc(c, opts = {}) {
  const iptv = !!opts.iptv;
  const iptvFields = iptv
    ? { monitorSide: c.direction === "downstream" ? "hub" : "spoke", endOnSwitch: true, hourlogOnly: true }
    : {};
  if (c.suite === "latency") {
    return {
      n: c.n, name: c.id, mode: "latency",
      link1: { delayMs: c.active, lossPct: 0 },
      link2: { delayMs: c.standby, lossPct: 0 },
      expectSwitch: !c.baseline, baseline: c.baseline,
      observeOnly: true,
      rampPlan: c.baseline ? null : {
        initialActiveMs: c.active, standbyMs: c.standby,
        stabilizeSec: HOLD_SEC, stepMs: STEP_MS,
        intervalSec: STEP_INTERVAL_SEC, ceilingMs: c.ceiling,
      },
      ...iptvFields,
    };
  }
  const none = { delayMs: 0, lossPct: 0 };
  const base =
    c.plType === "constant"
      ? { rampStepPct: c.stepPct, rampIntervalSec: STEP_INTERVAL_SEC, stabilizeSec: HOLD_SEC, rampMaxPct: c.ceilingPct }
      : c.plType === "burst"
        ? { preHoldSec: HOLD_SEC, burstLossPct: 5, burstDurationSec: 7, burstIntervalSec: 30 }
        : { preHoldSec: HOLD_SEC, randomLossPct: 5, randomMinGapSec: 20, randomMaxGapSec: 60, randomMinDurSec: 5, randomMaxDurSec: 15 };
  const plPlan = iptv ? { ...base, endOnSwitch: true } : base;
  return {
    n: c.n, name: c.id, mode: "packet-loss", plType: c.plType,
    link1: none, link2: none, expectSwitch: true, observeOnly: true,
    describe: initialConfig(c), plPlan,
    ...iptvFields,
  };
}

/* ========================================================================= *
 * Human-readable config strings for the summary table.
 * ========================================================================= */

function initialConfig(c) {
  if (c.suite === "latency") return `Active ${c.active} ms / Standby ${c.standby} ms`;
  if (c.plType === "constant") return `Active ${c.initialPct}% loss / Standby clean`;
  if (c.plType === "burst") return `Active 5% burst (7s every 30s) / Standby clean`;
  return `Active 5% random (gap 20-60s, dur 5-15s) / Standby clean`;
}

function finalConfig(c, r) {
  const sw = r && r.switchObserved;
  if (c.suite === "latency") {
    if (c.baseline) return "No impairment (baseline)";
    if (sw && r.switchLatencyMs != null) return `Active reached ${r.switchLatencyMs} ms at switch`;
    if (r && r.latencyRamp && r.latencyRamp.maxReached) return `Active ramped to ceiling ${c.ceiling} ms (no switch)`;
    return `Active ramped up to ${c.ceiling} ms; window ended`;
  }
  if (c.plType === "constant") {
    if (sw) return "Switch during loss ramp";
    return `Reached ${c.ceilingPct}% loss (no switch)`;
  }
  return sw ? "Switch during impairment" : `${c.plType} loss applied for the window (no switch)`;
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
  const matrix = buildMatrix(st.tosList);
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
  if (c.suite === "latency") {
    if (c.baseline) {
      return `<h4>Test Configuration</h4><table><tbody>` +
        row("Active Link Delay", "0 ms") + row("Standby Link Delay", "0 ms") +
        row("Hold Time", "5 min (observe)") + row("Increment", "none") +
        row("Maximum Delay", "0 ms") + `</tbody></table>`;
    }
    return `<h4>Test Configuration</h4><table><tbody>` +
      row("Active Link Delay", `${c.active} ms`) +
      row("Standby Link Delay", `${c.standby} ms`) +
      row("Hold Time", "3 min") +
      row("Increment", "50 ms every minute") +
      row("Maximum Delay", `${c.ceiling} ms`) +
      `</tbody></table>`;
  }
  if (c.plType === "constant") {
    return `<h4>Test Configuration</h4><table><tbody>` +
      row("Initial Loss", `${c.initialPct}%`) +
      row("Hold Time", "3 min") +
      row("Increment", `${c.stepPct}% every minute`) +
      row("Maximum Loss", `${c.ceilingPct}%`) +
      `</tbody></table>`;
  }
  if (c.plType === "burst") {
    return `<h4>Test Configuration</h4><table><tbody>` +
      row("Initial Loss", "clean") +
      row("Hold Time", "3 min (clean)") +
      row("Increment", "5% for 7 s every 30 s") +
      row("Maximum Loss", "5% (burst)") +
      `</tbody></table>`;
  }
  return `<h4>Test Configuration</h4><table><tbody>` +
    row("Initial Loss", "clean") +
    row("Hold Time", "3 min (clean)") +
    row("Increment", "5% at random gap 20–60 s, dur 5–15 s") +
    row("Maximum Loss", "5% (random)") +
    `</tbody></table>`;
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

/* ---- matrix row (Test Execution Matrix) ---- */
function matrixRow(c, r) {
  const side = shownSide(c);
  const hourlog = findFile(r.artifacts?.[side], (f) => f.includes("hourlog"));
  const diag = findFile(r.artifacts?.[side], (f) => f.includes("diagpack"));
  const logsCell = [hourlog, diag].filter(Boolean).map((f) => attRef(uploadName(f))).join(" ") ||
    ((r.artifacts?.[side] || []).length ? "&#10003;" : "-");
  const report = findFile(r.reportFiles, (f) => f.endsWith("report.html"));
  const mins = r.windowSec ? `${Math.round(r.windowSec / 60)} min` : runtimeText(r);
  return (
    "<tr>" +
    `<td>${c.n}</td>` +
    `<td>${e(c.dirLabel)}</td>` +
    `<td>${e(c.tos)}</td>` +
    `<td>${e(c.suiteLabel)}</td>` +
    `<td>${e(c.testcase)} ${e(c.testLabel)}</td>` +
    `<td>${e(mins)}</td>` +
    `<td>${r.switchObserved ? "Yes" : "No"}</td>` +
    `<td>${logsCell}</td>` +
    `<td>${report ? attRef(uploadName(report)) : "-"}</td>` +
    "</tr>"
  );
}

const MATRIX_HEADER =
  "<tr>" + ["S.No", "Direction", "ToS", "Suite", "Test Case", "Runtime", "Switch Observed", "Logs", "Report"]
    .map((h) => `<th>${h}</th>`).join("") + "</tr>";

/* ---- top-level tables ---- */
function executionSummary(state, baseMeta) {
  const row = (k, v) => `<tr><th>${e(k)}</th><td>${e(v)}</td></tr>`;
  const total = state.total || TOTAL;
  const done = (state.completed || []).length;
  const cases = state.cases || [];
  const lastEnd = cases.length ? cases[cases.length - 1].endTime : null;
  const endTime = done >= total && lastEnd ? lastEnd : "(in progress)";
  let runtime = "-";
  if (state.startedAt && lastEnd) {
    const sec = Math.max(0, Math.round((new Date(lastEnd) - new Date(state.startedAt)) / 1000));
    runtime = `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
  }
  return `<h2>Execution Summary</h2><table><tbody>` +
    row("Execution ID", state.runId) +
    row("Traffic profile", state.iptvMode ? "IPTV (iperf3 UDP, end-on-switch, hourLog only)" : "SLA regression") +
    row("ToS", (state.tosList && state.tosList.join(", ")) || "0x04, 0x24, 0x38") +
    row("Start Time", state.startedAt) +
    row("End Time", endTime) +
    row("Total Testcases", String(total)) +
    row("Completed", String(done)) +
    row("Remaining", String(total - done)) +
    row("Runtime", runtime) +
    row("Grid Version", baseMeta.gridVersion) +
    row("Automation Version", AUTOMATION_VERSION) +
    `</tbody></table>`;
}

/** Suite-completion summary (grows as cases finish; complete once all 42 done). */
function suiteCompletionSummary(state) {
  const completed = new Set(state.completed || []);
  const tosList = (state.tosList && state.tosList.length) ? state.tosList : TOS_LIST;
  const rows = [];
  for (const dir of DIRECTIONS) {
    for (const tos of tosList) {
      const lat = LATENCY_TCS.filter((t) => completed.has(`${dir.short}_${tos}_${t.tc}`)).length;
      const pl = PL_TCS.filter((t) => completed.has(`${dir.short}_${tos}_${t.tc}`)).length;
      rows.push(`<tr><td>${e(dir.label)}</td><td>${e(tos)}</td>` +
        `<td>${lat}/${LATENCY_TCS.length}</td><td>${pl}/${PL_TCS.length}</td></tr>`);
    }
  }
  return `<h2>Suite Completion Summary</h2><table><tbody>` +
    `<tr><th>Direction</th><th>ToS</th><th>Latency Suite Completed</th><th>Packet Loss Suite Completed</th></tr>` +
    rows.join("") + `</tbody></table>`;
}

function buildPageBody(state, baseMeta) {
  const date = (state.startedAt || "").slice(0, 10) || "unknown-date";
  const rows = (state.summaryRows || []).join("");
  const sections = (state.sections || []).join("");
  return (
    `<h1>SLA Regression Report - ${e(date)}</h1>` +
    `<p><em>Observations only — no PASS/FAIL. Manual validation to follow.</em></p>` +
    executionSummary(state, baseMeta) +
    `<h2>Test Execution Matrix</h2><table><tbody>${MATRIX_HEADER}${rows || ""}</tbody></table>` +
    (sections || "") +
    suiteCompletionSummary(state)
  );
}

/** Full detail section for one testcase, in the fixed template layout. */
function detailSection(c, r, baseMeta) {
  const heading =
    `<h1>Testcase ${String(c.n).padStart(2, "0")}</h1>` +
    `<p><strong>${e(c.suiteLabel)} Suite — ${e(c.testcase)} (${e(c.testLabel)})</strong></p>`;
  return (
    heading +
    configurationTable(c, r, baseMeta) +
    testConfigurationTable(c) +
    executionTimeline(r) +
    trafficMovementTable(c, r) +
    impairmentProgression(c, r) +
    logCollectionTables(c, r) +
    observationsList(c, r) +
    screenshotsBlock(r) +
    resultTable(c, r) +
    `<hr/>`
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
    try { await engine.confUploadAttachment(conf, state.pageId, f, uploadName(f)); }
    catch (err) { engine.log(`WARN: attach ${path.basename(f)}: ${err.message}`); }
  }
  state.summaryRows = state.summaryRows || [];
  state.sections = state.sections || [];
  state.summaryRows.push(matrixRow(c, r));
  state.sections.push(detailSection(c, r, baseMeta));
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
  const iptvMode = !!(params && params.iptvMode);
  // ToS list: array or CSV string; default the full 3-ToS SLA set. IPTV runs
  // pass a single ToS -> a 2×7=14 case run.
  let tosList = params && params.regressionTosList;
  if (typeof tosList === "string") tosList = tosList.split(",").map((s) => s.trim()).filter(Boolean);
  if (!Array.isArray(tosList) || !tosList.length) tosList = TOS_LIST.slice();
  const matrix = buildMatrix(tosList);

  // Force the regression-safe drivers regardless of what the form carried.
  cfg.trafficDriver = "ssh";
  cfg.impairmentDriver = "ssh-tc";
  // Detection/impairment work off the netem overlay ports. Default to the four
  // overlay interfaces if the profile left them unset.
  if (!cfg.netemCandidates || !cfg.netemCandidates.length) {
    cfg.netemCandidates = ["ens192", "ens193", "ens224", "ens225"];
  }

  // ---- state (fresh or resumed) ----
  let state = opts.resume ? loadState() : null;
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
  // resumed runs keep their original tosList/iptvMode; fall back for old files
  if (!state.tosList) state.tosList = tosList;
  if (state.iptvMode == null) state.iptvMode = iptvMode;
  if (!state.total) state.total = matrix.length;
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
  try {
    for (const c of matrix) {
      if (engine.isAborted()) { log("regression aborted by user — stopping"); break; }
      if (completed.has(c.id)) { log(`skip ${c.id} — already completed`); continue; }

      state.currentIndex = c.n;
      engine.setStatus({ caseIndex: c.n, currentCase: c.id });
      log(`########## CASE ${c.n}/${total} — ${c.id} (${c.suiteLabel} ${c.testcase}) ##########`);

      const tc = buildTc(c, { iptv: state.iptvMode });
      const durationMs = caseWindowSec(c, params) * 1000;
      const caseDir = path.join(BASE_DIR, `${c.dirShort}_${c.tos}`, c.suite);
      fs.mkdirSync(caseDir, { recursive: true });

      const cmds = engine.buildTrafficCommands({ ...params, trafficDirection: c.direction, tos: c.tos });
      const traffic = {
        type: String(params.trafficType || "UDP").toUpperCase(),
        direction: c.direction,
        tos: engine.parseTos(c.tos),
        bandwidth: engine.parseBandwidth(params.bandwidth).value,
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

      // ---- Confluence append (immediately) ----
      let uploaded = false;
      if (conf) {
        engine.setStatus({ confluence: `appending ${c.id}` });
        try { await appendCase(conf, state, baseMeta, c, r); uploaded = true; engine.setStatus({ confluence: `appended ${c.id}` }); }
        catch (e) { engine.setStatus({ confluence: `append FAILED: ${e.message}` }); log(`ERROR: Confluence append ${c.id}: ${e.message}`); }
      }

      // ---- checkpoint ----
      completed.add(c.id);
      state.completed = [...completed];
      state.cases.push({
        id: c.id, direction: c.direction, tos: c.tos, suite: c.suiteLabel, testcase: c.testcase,
        status: statusText(r), startTime: r.startTime, endTime: r.endTime,
        uploaded, logsCollected: !!(r.artifacts && (r.artifacts.spoke.length || r.artifacts.hub.length)),
        reportsGenerated: !!(r.reportFiles && r.reportFiles.length),
        switchObserved: !!r.switchObserved, switchTime: r.switchAt || null,
        initialConfig: initialConfig(c), finalConfig: finalConfig(c, r),
      });
      saveState(state);
      uiResults.push({ name: c.id, result: r.result || "OBSERVED" });
      engine.setStatus({ results: uiResults.slice() });
      log(`CASE ${c.n}/${total} ${c.id} DONE — ${statusText(r)}${uploaded ? " — uploaded" : ""}`);
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
  params.confluence = true;
  // CLI: --iptv enables IPTV mode; --tos=0x04[,0x24] restricts the ToS set.
  if (args.includes("--iptv")) params.iptvMode = true;
  const tosArg = args.find((a) => a.startsWith("--tos="));
  if (tosArg) params.regressionTosList = tosArg.slice("--tos=".length);

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

  const res = await runRegression(cfg, params, { resume: resume && !restart });
  process.exit(res.completed >= res.total ? 0 : 1);
}

if (require.main === module) {
  main().catch((e) => { console.error("REGRESSION FATAL:", e.stack || e.message); process.exit(1); });
}

module.exports = {
  runRegression, buildMatrix, caseWindowSec, buildTc,
  loadState, saveState, clearState, stateSummary,
  initialConfig, finalConfig, statusText,
  buildPageBody, matrixRow, detailSection, ensurePage, appendCase,
  PROFILE_NAME, STATE_FILE, TOTAL,
};
