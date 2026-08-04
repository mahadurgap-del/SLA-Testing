#!/usr/bin/env node
/**
 * CLI runner — same engine as the web panel, for scripted / headless use.
 *
 *   node troubleshoot.js --config testbed.json [--no-probes] [--json]
 *
 * testbed.json:
 * {
 *   "esxi":  { "host": "172.16.226.10", "user": "root", "pass": "…" },
 *   "nodes": {
 *     "client": { "host": "172.16.226.50", "user": "root", "pass": "…", "vmName": "client-vm",
 *                 "dataIp": "10.10.1.2" },
 *     "spoke":  { "host": "172.16.226.113", "user": "root", "pass": "…" },
 *     "netem":  { "host": "172.16.226.199", "user": "root", "pass": "…" },
 *     "hub":    { "host": "172.16.226.120", "user": "root", "pass": "…" },
 *     "server": { "host": "172.16.226.60",  "user": "root", "pass": "…", "dataIp": "10.10.9.2" }
 *   },
 *   "options": { "maxHops": 12, "mtuBytes": 1500 }
 * }
 *
 * Passwords may be left out of the file and supplied as ESXI_PASS, CLIENT_PASS,
 * SPOKE_PASS, NETEM_PASS, HUB_PASS, SERVER_PASS instead.
 */

"use strict";

const fs = require("fs");
const engine = require("./lib/engine");
const { ROLE_ORDER } = require("./lib/diagnose");
const { VERDICT_TEXT } = require("./lib/report");

function parseArgs(argv) {
  const out = { config: null, probes: true, json: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--config" || a === "-c") out.config = argv[++i];
    else if (a === "--no-probes") out.probes = false;
    else if (a === "--json") out.json = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else { console.error(`unknown argument: ${a}`); out.help = true; }
  }
  return out;
}

function usage() {
  console.log("usage: node troubleshoot.js --config testbed.json [--no-probes] [--json]");
  console.log("       see the header of this file for the config format");
}

function withEnvSecrets(cfg) {
  const c = { esxi: { ...(cfg.esxi || {}) }, nodes: {}, options: { ...(cfg.options || {}) } };
  c.esxi.pass = c.esxi.pass || process.env.ESXI_PASS || "";
  for (const role of ROLE_ORDER) {
    const n = { ...((cfg.nodes || {})[role] || {}) };
    if (!n.host) continue;
    n.pass = n.pass || process.env[`${role.toUpperCase()}_PASS`] || "";
    c.nodes[role] = n;
  }
  return c;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help || !args.config) { usage(); process.exit(args.help ? 0 : 2); }

  const cfg = withEnvSecrets(JSON.parse(fs.readFileSync(args.config, "utf8")));
  cfg.options.activeProbes = args.probes;

  const check = engine.validateConfig(cfg);
  if (!check.ok) {
    for (const [k, v] of Object.entries(check.errors)) console.error(`config error — ${k}: ${v}`);
    process.exit(2);
  }

  if (!args.json) engine.bus.on("log", (line) => console.log(line));

  const result = await engine.runDiagnosis(cfg);

  if (args.json) {
    console.log(fs.readFileSync(result.reportPaths.json, "utf8"));
  } else {
    console.log("");
    console.log(`==== ${VERDICT_TEXT[result.verdict] || result.verdict} ====`);
    console.log(result.summary);
    console.log("");
    result.findings.forEach((f, i) => {
      console.log(`${i + 1}. [${f.layer}/${f.severity}] ${f.where}: ${f.title}`);
      console.log(`   ${f.detail}`);
      if (f.evidence) console.log(`   evidence: ${f.evidence}`);
      if (f.remediation) console.log(`   fix: ${f.remediation}`);
      console.log("");
    });
    console.log(`report: ${result.reportPaths.html}`);
  }
  // L2/L3/ACCESS/INCONCLUSIVE -> non-zero, so CI can gate on a clean testbed
  process.exit(["HEALTHY", "HEALTHY_WARN"].includes(result.verdict) ? 0 : 1);
}

main().catch((e) => {
  console.error(`FATAL: ${e.message}`);
  process.exit(1);
});
