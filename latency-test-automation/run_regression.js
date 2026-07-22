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

/** Build the ordered list of 42 case descriptors. */
function buildMatrix() {
  const cases = [];
  let n = 0;
  for (const dir of DIRECTIONS) {
    for (const tos of TOS_LIST) {
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

/** Per-case observation window in seconds. */
function caseWindowSec(c, params) {
  let sec;
  if (c.suite === "latency") {
    if (c.baseline) sec = 300;
    else {
      const steps = Math.ceil((c.ceiling - c.active) / STEP_MS);
      sec = HOLD_SEC + steps * STEP_INTERVAL_SEC + TAIL_SEC;
    }
  } else if (c.plType === "constant") {
    const steps = Math.ceil((c.ceilingPct - c.initialPct) / c.stepPct);
    sec = HOLD_SEC + steps * STEP_INTERVAL_SEC + TAIL_SEC;
  } else {
    sec = HOLD_SEC + 120; // burst / random: 5-minute case (3-min clean + 2-min active)
  }
  const cap = parseInt(params && params.caseMaxSec, 10);
  if (cap && cap > 0) sec = Math.min(sec, cap);
  return sec;
}

/** Build the engine `tc` object (schedule driver) for a case. */
function buildTc(c) {
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
    };
  }
  const none = { delayMs: 0, lossPct: 0 };
  const plPlan =
    c.plType === "constant"
      ? { rampStepPct: c.stepPct, rampIntervalSec: STEP_INTERVAL_SEC, stabilizeSec: HOLD_SEC, rampMaxPct: c.ceilingPct }
      : c.plType === "burst"
        ? { preHoldSec: HOLD_SEC, burstLossPct: 5, burstDurationSec: 7, burstIntervalSec: 30 }
        : { preHoldSec: HOLD_SEC, randomLossPct: 5, randomMinGapSec: 20, randomMaxGapSec: 60, randomMinDurSec: 5, randomMaxDurSec: 15 };
  return {
    n: c.n, name: c.id, mode: "packet-loss", plType: c.plType,
    link1: none, link2: none, expectSwitch: true, observeOnly: true,
    describe: initialConfig(c), plPlan,
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
  const matrix = buildMatrix();
  const completed = new Set(st.completed || []);
  const next = matrix.find((c) => !completed.has(c.id));
  return {
    exists: true,
    profileName: st.profileName || PROFILE_NAME,
    startedAt: st.startedAt || null,
    total: TOTAL,
    completedCount: completed.size,
    done: completed.size >= TOTAL,
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

const SUMMARY_HEADER =
  "<tr>" +
  ["Test ID", "Direction", "ToS", "Suite", "Testcase", "Runtime",
   "Initial Configuration", "Final Configuration", "Switch Observed",
   "Switch Time", "Artifacts", "Status"]
    .map((h) => `<th>${h}</th>`).join("") +
  "</tr>";

function metaTable(state, baseMeta) {
  const e = engine.escapeXml;
  const completed = (state.completed || []).length;
  return (
    `<table><tbody>` +
    `<tr><th>Profile</th><td>${e(state.profileName)}</td></tr>` +
    `<tr><th>Started</th><td>${e(state.startedAt)}</td></tr>` +
    `<tr><th>GRID version</th><td>${e(baseMeta.gridVersion)}</td></tr>` +
    `<tr><th>Topology</th><td>${e(baseMeta.topology)}</td></tr>` +
    `<tr><th>Spoke / Hub</th><td>${e(baseMeta.spokeHost)} / ${e(baseMeta.hubHost)}</td></tr>` +
    `<tr><th>Progress</th><td>${completed} / ${TOTAL} test cases</td></tr>` +
    `</tbody></table>` +
    `<p><em>Observations only — no PASS/FAIL. Manual validation to follow.</em></p>`
  );
}

function buildPageBody(state, baseMeta) {
  const rows = (state.summaryRows || []).join("");
  const sections = (state.sections || []).join("");
  return (
    `<h1>SLA Full Regression (6&#215;7 Matrix)</h1>` +
    metaTable(state, baseMeta) +
    `<h2>Summary</h2><table><tbody>${SUMMARY_HEADER}${rows}</tbody></table>` +
    `<h2>Test case detail</h2>${sections || "<p>(none yet)</p>"}`
  );
}

/** Attachment reference macro for a local file path. */
function attRef(name) {
  return `<ac:link><ri:attachment ri:filename="${engine.escapeXml(name)}"/></ac:link>`;
}

/** Generic filenames collide across case folders — prefix with the folder name. */
const GENERIC = ["observations.txt", "summary.json", "summary.md", "report.html",
  "sla_traffic_client.log", "sla_traffic_server.log"];
function uploadName(f) {
  const b = path.basename(f);
  return GENERIC.includes(b) ? `${path.basename(path.dirname(f))}_${b}` : b;
}

function caseArtifacts(r) {
  return [
    ...(r.artifacts?.spoke || []),
    ...(r.artifacts?.hub || []),
    ...(r.artifacts?.traffic || []),
    ...(r.screenshots || []),
    ...(r.reportFiles || []),
  ].filter(Boolean);
}

function summaryRow(c, r) {
  const e = engine.escapeXml;
  const files = caseArtifacts(r);
  const artLinks = files.map((f) => attRef(uploadName(f))).join("<br/>") || "-";
  return (
    "<tr>" +
    `<td>${e(c.id)}</td>` +
    `<td>${e(c.dirLabel)}</td>` +
    `<td>${e(c.tos)}</td>` +
    `<td>${e(c.suiteLabel)}</td>` +
    `<td>${e(c.testcase)} ${e(c.testLabel)}</td>` +
    `<td>${e(runtimeText(r))}</td>` +
    `<td>${e(initialConfig(c))}</td>` +
    `<td>${e(finalConfig(c, r))}</td>` +
    `<td>${r.switchObserved ? "Yes" : "No"}</td>` +
    `<td>${e(r.switchAt || (r.switches && r.switches[0] && r.switches[0].time) || "-")}</td>` +
    `<td>${artLinks}</td>` +
    `<td>${e(statusText(r))}</td>` +
    "</tr>"
  );
}

function detailSection(c, r) {
  const e = engine.escapeXml;
  const row = (k, v) => `<tr><th>${e(k)}</th><td>${e(v)}</td></tr>`;
  const config =
    `<h4>Configuration</h4><table><tbody>` +
    row("Direction", c.dirLabel) +
    row("ToS", c.tos) +
    row("Suite", c.suiteLabel) +
    row("Testcase", `${c.testcase} — ${c.testLabel}`) +
    row("Runtime", runtimeText(r)) +
    row("Initial configuration", initialConfig(c)) +
    row("Final configuration", finalConfig(c, r)) +
    (r.clientCmd ? row("Client command", r.clientCmd) : "") +
    row("Window", `${r.startTime || "-"} .. ${r.endTime || "-"}`) +
    `</tbody></table>`;

  // Latency / packet-loss progression + timeline
  const prog = (r.impairments && r.impairments.length)
    ? `<h4>Progression / Timeline</h4><table><tbody>` +
      `<tr><th>Time</th><th>Event</th><th>Link</th></tr>` +
      r.impairments.map((ev) =>
        `<tr><td>${e(engine.offsetStr(r.startTime, ev.t))}</td><td>${e(ev.event)}</td><td>${e(ev.iface)}</td></tr>`
      ).join("") +
      `</tbody></table>`
    : "";

  const moves = engine.trafficMovement(r);
  const movement =
    `<h4>Traffic movement / Link transitions</h4>` +
    (moves.length
      ? `<table><tbody><tr><th>Time</th><th>Link</th></tr>` +
        moves.map((m) => `<tr><td>${e(m.at)}</td><td>${e(m.what)}</td></tr>`).join("") +
        `</tbody></table>`
      : `<p>No link switch observed.</p>`);

  const checklist = engine.artifactChecklist(r)
    .map(([name, ok]) => `<li>${ok ? "&#10003;" : "&#10007;"} ${e(name)}</li>`).join("");
  const files = caseArtifacts(r);
  const attachments =
    `<h4>Artifacts</h4><ul>${checklist}</ul><p>` +
    files.map((f) => attRef(uploadName(f))).join(" &nbsp; ") + `</p>`;

  const shots = (r.screenshots || [])
    .map((p) => `<ac:image ac:width="480"><ri:attachment ri:filename="${e(path.basename(p))}"/></ac:image>`)
    .join(" ");
  const errs = (r.errors && r.errors.length)
    ? `<p><strong>Errors:</strong> ${e(r.errors.join(" | "))}</p>` : "";

  return (
    `<h3>${e(c.id)} — ${e(c.suiteLabel)} ${e(c.testcase)} (${e(c.testLabel)})</h3>` +
    config + prog + movement + attachments +
    `<h4>Observation</h4><p><strong>${e(statusText(r))}</strong></p>` +
    errs + shots + `<hr/>`
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

  const title = `SLA Full Regression (6x7 Matrix) — ${state.startedAt.replace(/[:]/g, "-")}`;
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
  // upload artifacts first so the row/section attachment links resolve
  for (const f of caseArtifacts(r)) {
    try { await engine.confUploadAttachment(conf, state.pageId, f, uploadName(f)); }
    catch (e) { engine.log(`WARN: attach ${path.basename(f)}: ${e.message}`); }
  }
  state.summaryRows = state.summaryRows || [];
  state.sections = state.sections || [];
  state.summaryRows.push(summaryRow(c, r));
  state.sections.push(detailSection(c, r));
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
  const matrix = buildMatrix();

  // Force the regression-safe drivers regardless of what the form carried.
  cfg.trafficDriver = "ssh";
  cfg.impairmentDriver = "ssh-tc";

  // ---- state (fresh or resumed) ----
  let state = opts.resume ? loadState() : null;
  if (!state) {
    state = {
      runId: `sla-reg-${new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14)}`,
      startedAt: new Date().toISOString(),
      profileName: PROFILE_NAME,
      currentIndex: 0,
      total: TOTAL,
      pageId: null, pageTitle: null, pageUrl: null,
      completed: [],
      summaryRows: [], sections: [],
      cases: [],
    };
    saveState(state);
  }
  const completed = new Set(state.completed || []);

  engine.clearAbort();
  engine.resetRunLogs();
  engine.setStatus({ phase: "running", caseCount: TOTAL, caseIndex: completed.size, mode: "regression" });

  // ---- infrastructure once ----
  await engine.preflight(cfg);
  if (cfg.netemSsh && (cfg.netemSsh.pass || cfg.netemSsh.keyPath)) await engine.sanitizeNetem(cfg);

  const baseMeta = await engine.collectRunMetadata(cfg, params.trafficType, "-", "-");

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
      log(`########## CASE ${c.n}/${TOTAL} — ${c.id} (${c.suiteLabel} ${c.testcase}) ##########`);

      const tc = buildTc(c);
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

      // ---- reports for this case ----
      try {
        const html = engine.writeHtmlReport(caseDir, [r], caseMeta);
        engine.writeSummary(caseDir, [r], caseMeta);
        r.reportFiles = [html, path.join(caseDir, "summary.json")];
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
      log(`CASE ${c.n}/${TOTAL} ${c.id} DONE — ${statusText(r)}${uploaded ? " — uploaded" : ""}`);
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
  log(`=== REGRESSION ${aborted ? "ABORTED" : "COMPLETE"} — ${done}/${TOTAL} cases — page ${state.pageId || "(none)"} ===`);
  return { pageId: state.pageId, completed: done, total: TOTAL, state, aborted };
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

  const check = engine.validateParams(params);
  if (!check.ok) { console.error(`invalid params: ${JSON.stringify(check.errors)}`); process.exit(1); }
  const cfg = engine.buildConfig(params);

  const summary = stateSummary();
  if (summary && !summary.done && !resume && !restart) {
    console.log(`\nPrevious SLA Regression found — completed ${summary.completedCount}/${TOTAL}.`);
    console.log(`Resume from: ${summary.resumeFrom ? `${summary.resumeFrom.direction} · ToS ${summary.resumeFrom.tos} · ${summary.resumeFrom.suite} ${summary.resumeFrom.testcase}` : "(end)"}`);
    console.log(`Run with --resume to continue, or --restart to start over.\n`);
    process.exit(0);
  }

  const res = await runRegression(cfg, params, { resume: resume && !restart });
  process.exit(res.completed >= TOTAL ? 0 : 1);
}

if (require.main === module) {
  main().catch((e) => { console.error("REGRESSION FATAL:", e.stack || e.message); process.exit(1); });
}

module.exports = {
  runRegression, buildMatrix, caseWindowSec, buildTc,
  loadState, saveState, clearState, stateSummary,
  initialConfig, finalConfig, statusText,
  buildPageBody, summaryRow, detailSection, ensurePage, appendCase,
  PROFILE_NAME, STATE_FILE, TOTAL,
};
