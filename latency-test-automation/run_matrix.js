#!/usr/bin/env node
/**
 * Full test matrix runner (overnight, unattended).
 *
 *   6 runs = 2 directions (upstream, downstream) x 3 ToS (0x04, 0x24, 0x38)
 *   each run = mode "all" = latency TC1-TC4 + packet-loss PL1-PL3
 *   => 42 test cases total.
 *
 * Timing per the updated methodology:
 *   - latency TC2-4: hold 3 min, then +50ms/60s until switch or max (10-min case)
 *   - packet-loss:   hold 3 min, then +2%/60s until switch or max (10-min case)
 *   - TC1 baseline:  5 min, no impairment
 *
 * Each of the 6 runs publishes its own section (labelled Direction · ToS) with
 * all logs/diag packs/reports to the configured Confluence page. Per-run
 * publishing means partial progress is saved even if the matrix is interrupted.
 *
 * Config/credentials come from the saved panel profile (profiles.json
 * __default__). Run:  node run_matrix.js    (or in the background)
 */
"use strict";
const fs = require("fs");
const path = require("path");
const engine = require("./run_latency_tests.js");

const PROFILE = JSON.parse(fs.readFileSync(path.join(__dirname, "profiles.json"), "utf8")).__default__;
if (!PROFILE) { console.error("no saved profile (profiles.json __default__) — open the panel and Start once"); process.exit(1); }

const DIRECTIONS = ["upstream", "downstream"];
const TOS_LIST = ["0x04", "0x24", "0x38"];

const RUN_PARAMS = {
  mode: "all",                 // latency (TC1-4) + packet-loss (PL1-3)
  confluence: true,
  debugMode: false,
  latencyRampEnabled: true,    // hold-then-ramp per the methodology
  durationSec: "600",          // 10-min impairment cases
  baselineDurationSec: "300",  // 5-min TC1
  latencyStabilizeSec: "180",  // 3-min hold before latency ramp
  latencyRampStepMs: "50",
  latencyRampIntervalSec: "60",
  latencyRampMaxMs: "1000",
  plStabilizeSec: "180",       // 3-min hold before loss ramp
  rampStepPct: "2",
  rampIntervalSec: "60",
  plRampMaxPct: "20",
};

(async () => {
  const started = new Date().toISOString();
  console.log(`=== MATRIX START ${started} — ${DIRECTIONS.length}x${TOS_LIST.length} = ${DIRECTIONS.length * TOS_LIST.length} runs ===`);
  const summary = [];
  let n = 0;
  for (const direction of DIRECTIONS) {
    for (const tos of TOS_LIST) {
      n++;
      const tag = `${direction}/${tos}`;
      console.log(`\n########## RUN ${n}/6 — ${tag} ##########`);
      const params = { ...PROFILE, ...RUN_PARAMS, trafficDirection: direction, tos };
      const check = engine.validateParams(params);
      if (!check.ok) { console.error(`SKIP ${tag}: invalid params ${JSON.stringify(check.errors)}`); summary.push({ tag, error: "invalid params" }); continue; }
      const cfg = engine.buildConfig(params);
      try {
        const res = await engine.runSuite(cfg, params);
        const line = res.results.map((r) => `${r.name}:${r.result}`).join(" ");
        console.log(`RUN ${n}/6 ${tag} DONE — page ${res.pageId || "(publish failed)"} — ${line}`);
        summary.push({ tag, pageId: res.pageId, results: res.results.map((r) => ({ n: r.name, r: r.result })) });
      } catch (e) {
        console.error(`RUN ${n}/6 ${tag} FAILED: ${e.message}`);
        summary.push({ tag, error: e.message });
      }
    }
  }
  console.log(`\n=== MATRIX COMPLETE ${new Date().toISOString()} (started ${started}) ===`);
  for (const s of summary) {
    console.log(`  ${s.tag}: ${s.error ? "ERROR " + s.error : "page " + s.pageId + " — " + s.results.map((x) => x.n + ":" + x.r).join(" ")}`);
  }
  process.exit(0);
})().catch((e) => { console.error("MATRIX FATAL:", e.stack || e.message); process.exit(1); });
