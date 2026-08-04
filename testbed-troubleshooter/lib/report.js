/** Report writers — a JSON fact dump plus a self-contained HTML report. */

"use strict";

const fs = require("fs");
const path = require("path");
const { ROLE_LABEL } = require("./diagnose");

function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const VERDICT_TEXT = {
  L2: "LAYER 2 ISSUE",
  L3: "LAYER 3 ISSUE",
  ACCESS: "TESTBED NOT FULLY REACHABLE",
  HEALTHY: "NO FAULT FOUND",
  HEALTHY_WARN: "WORKING — WITH WARNINGS",
  INCONCLUSIVE: "INCONCLUSIVE",
};

/** Strip credentials before anything is written to disk. */
function scrub(facts) {
  const out = JSON.parse(JSON.stringify(facts, (k, v) => {
    if (["pass", "keyPath", "sudoPass"].includes(k)) return v ? "***" : v;
    return v;
  }));
  return out;
}

function segRow(seg) {
  const cls = { ok: "ok", l2: "bad", l3: "bad", filtered: "warn", unknown: "warn" }[seg.status || "unknown"];
  return `<tr>
    <td>${esc(ROLE_LABEL[seg.a])} &rarr; ${esc(ROLE_LABEL[seg.b])}${seg.viaBridge && seg.viaBridge.length
      ? ` <span class="mut">(via ${esc(seg.viaBridge.join(", "))} bridge)</span>` : ""}</td>
    <td>${esc(seg.subnet || "—")}</td>
    <td>${seg.aAddr ? esc(`${seg.aAddr.ip} (${seg.aAddr.iface})`) : "—"}</td>
    <td>${seg.portA ? esc(`${seg.portA.portgroup} / ${seg.portA.vswitch}`) : "—"}</td>
    <td>${seg.bAddr ? esc(`${seg.bAddr.ip} (${seg.bAddr.iface})`) : "—"}</td>
    <td>${seg.portB ? esc(`${seg.portB.portgroup} / ${seg.portB.vswitch}`) : "—"}</td>
    <td>${seg.sameL2Domain === null ? "unknown" : seg.sameL2Domain ? "yes" : "<b>no</b>"}</td>
    <td>${seg.probe && seg.probe.neigh ? esc(`${seg.probe.neigh.state} ${seg.probe.neigh.mac || ""}`) : "—"}</td>
    <td class="${cls}">${esc((seg.status || "unknown").toUpperCase())}</td>
  </tr>`;
}

function findingCard(f, i) {
  return `<div class="card ${esc(f.severity)}">
    <div class="cardhead"><span class="tag ${esc(f.layer)}">${esc(f.layer)}</span>
      ${f.severity === f.layer ? "" : `<span class="tag sev-${esc(f.severity)}">${esc(f.severity)}</span>`}
      <b>${i + 1}. ${esc(f.title)}</b>
      <span class="mut">— ${esc(f.where)}</span></div>
    <p>${esc(f.detail)}</p>
    ${f.evidence ? `<pre>${esc(f.evidence)}</pre>` : ""}
    ${f.remediation ? `<p class="fix"><b>Fix:</b> ${esc(f.remediation)}</p>` : ""}
    <div class="mut mono">${esc(f.id)}</div>
  </div>`;
}

function nodeRow(role, node) {
  return `<tr>
    <td>${esc(ROLE_LABEL[role])}</td>
    <td>${esc(node.host)}${node.vmName ? ` <span class="mut">(VM ${esc(node.vmName)})</span>` : ""}</td>
    <td>${node.reachable ? esc(node.hostname || "yes") : `<span class="bad">${esc(node.error || "unreachable")}</span>`}</td>
    <td>${esc(node.kind || "—")}</td>
    <td>${(node.addrs || []).map((a) => esc(`${a.iface} ${a.ip}/${a.prefix}`)).join("<br>") || "—"}</td>
    <td>${Object.entries(node.ifacePorts || {}).map(([i, p]) =>
      esc(`${i} → ${p.portgroup} (${p.vswitch})`)).join("<br>") || "—"}</td>
    <td>${node.ipForward === undefined ? "—" : node.ipForward ? "on" : "<b>off</b>"}</td>
    <td>${node.netemActive ? "netem active" : "—"}</td>
  </tr>`;
}

function html(facts, topo, result) {
  const now = new Date().toISOString();
  const e2e = facts.probes.endToEnd || {};
  const tr = e2e.traceroute;
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Testbed troubleshooter report — ${esc(result.verdict)}</title>
<style>
  body { font: 14px/1.55 system-ui, sans-serif; color:#1a1a2e; max-width:1180px; margin:24px auto; padding:0 16px; }
  h1 { font-size:22px; margin-bottom:4px; } h2 { font-size:16px; margin:26px 0 8px; }
  .mut { color:#64748b; } .mono { font-family:ui-monospace, monospace; font-size:11px; }
  .verdict { padding:14px 16px; border-radius:10px; font-size:18px; font-weight:700; margin:12px 0; }
  .verdict.L2, .verdict.L3, .verdict.ACCESS, .verdict.INCONCLUSIVE { background:#fee2e2; color:#991b1b; }
  .verdict.HEALTHY { background:#dcfce7; color:#166534; }
  .verdict.HEALTHY_WARN { background:#fef9c3; color:#854d0e; }
  .verdict .sub { display:block; font-size:13px; font-weight:400; margin-top:6px; white-space:pre-line; }
  table { border-collapse:collapse; width:100%; font-size:12.5px; margin-bottom:8px; }
  th, td { border:1px solid #e2e8f0; padding:5px 8px; text-align:left; vertical-align:top; }
  th { background:#f8fafc; }
  td.ok, .ok { color:#166534; font-weight:600; } td.bad, .bad { color:#991b1b; font-weight:600; }
  td.warn, .warn { color:#854d0e; font-weight:600; }
  .card { border:1px solid #e2e8f0; border-left-width:5px; border-radius:8px; padding:10px 12px; margin-bottom:10px; }
  .card.critical { border-left-color:#dc2626; } .card.warning { border-left-color:#f59e0b; }
  .card.info { border-left-color:#3b82f6; }
  .card p { margin:6px 0; } .card pre { background:#f1f5f9; padding:7px 9px; border-radius:6px; font-size:11.5px;
    overflow-x:auto; white-space:pre-wrap; }
  .fix { background:#f0fdf4; padding:6px 9px; border-radius:6px; }
  .tag { display:inline-block; padding:1px 7px; border-radius:9px; font-size:11px; font-weight:700; margin-right:6px; }
  .tag.L2 { background:#e0e7ff; color:#3730a3; } .tag.L3 { background:#ffedd5; color:#9a3412; }
  .tag.access { background:#fae8ff; color:#86198f; } .tag.info { background:#dbeafe; color:#1e40af; }
  .tag.sev-critical { background:#fee2e2; color:#991b1b; } .tag.sev-warning { background:#fef9c3; color:#854d0e; }
  .tag.sev-info { background:#e2e8f0; color:#334155; }
  .path { margin:10px 0; } .path .n { display:inline-block; border:1px solid #cbd5e1; border-radius:8px;
    padding:4px 12px; background:#fff; } .path .a { color:#64748b; padding:0 6px; }
</style></head><body>
<h1>Testbed troubleshooter report</h1>
<div class="mut">${esc(now)} · ESXi ${esc(facts.esxi && facts.esxi.ok ? facts.esxi.host : "not collected")}
 · flow ${esc(topo.target.srcIp || "?")} → ${esc(topo.target.dstIp || "?")}</div>

<div class="verdict ${esc(result.verdict)}">${esc(VERDICT_TEXT[result.verdict] || result.verdict)}
  <span class="sub">${esc(result.summary)}</span></div>

<div class="path">${topo.present.map((r) =>
    `<span class="n">${esc(ROLE_LABEL[r])}<br><span class="mono">${esc(facts.nodes[r].host)}</span></span>`)
    .join('<span class="a">→</span>')}</div>

<h2>Findings (${result.findings.length})</h2>
${result.findings.length ? result.findings.map(findingCard).join("") : "<p>No findings.</p>"}

<h2>Segments</h2>
<table><tr><th>Segment</th><th>Subnet</th><th>A address</th><th>A portgroup / vSwitch</th>
<th>B address</th><th>B portgroup / vSwitch</th><th>Same L2 domain</th><th>ARP</th><th>Status</th></tr>
${result.segments.map(segRow).join("")}</table>

<h2>Nodes</h2>
<table><tr><th>Role</th><th>Management</th><th>Reachable / hostname</th><th>Kind</th><th>Addresses</th>
<th>vNIC → portgroup</th><th>ip_forward</th><th>Notes</th></tr>
${topo.present.map((r) => nodeRow(r, facts.nodes[r])).join("")}</table>

<h2>End-to-end probes</h2>
<table><tr><th>Probe</th><th>Result</th></tr>
<tr><td>Forward ping ${esc(topo.target.srcIp || "?")} → ${esc(topo.target.dstIp || "?")}</td>
<td>${e2e.forward ? esc(`${e2e.forward.lossPct}% loss${e2e.forward.rttAvgMs ? `, ${e2e.forward.rttAvgMs} ms avg` : ""}`) : "not run"}</td></tr>
<tr><td>Reverse ping</td><td>${e2e.reverse ? esc(`${e2e.reverse.lossPct}% loss`) : "not run"}</td></tr>
<tr><td>Traceroute${tr ? ` (${esc(tr.via)})` : ""}</td>
<td class="mono">${tr ? esc(tr.hops.map((h) => `${h.ttl}:${h.ip || "*"}`).join("  ")) : "not run"}</td></tr>
${facts.probes.mtu ? `<tr><td>MTU probe (${esc(facts.probes.mtu.size)} B, DF)</td>
<td>${esc(`56B ${facts.probes.mtu.small.lossPct}% loss / ${facts.probes.mtu.size - 28}B DF ${facts.probes.mtu.large.lossPct}% loss`)}</td></tr>` : ""}
</table>

${facts.esxi && facts.esxi.ok ? `<h2>ESXi virtual networking</h2>
<table><tr><th>vSwitch</th><th>MTU</th><th>Uplinks</th><th>Portgroups (VLAN)</th></tr>
${facts.esxi.vswitches.map((v) => `<tr><td>${esc(v.name)} <span class="mut">${esc(v.kind)}</span></td>
<td>${esc(v.mtu)}</td><td>${esc(v.uplinks.join(", ") || "none")}</td>
<td>${facts.esxi.portgroups.filter((p) => p.vswitch === v.name)
      .map((p) => esc(`${p.name}${p.vlan === null ? "" : ` (VLAN ${p.vlan})`}`)).join(", ") || "—"}</td></tr>`).join("")}
</table>` : ""}

${result.fabric && result.fabric.length ? `<h2>L2 domains merged by</h2>
<ul class="mut">${result.fabric.map((m) => `<li>${esc(m)}</li>`).join("")}</ul>` : ""}

<p class="mut">Generated by testbed-troubleshooter. Read-only: no configuration was changed on the ESXi host or
any VM — only ICMP/ARP probes were sent.</p>
</body></html>`;
}

function write(dir, facts, topo, result) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = path.join(dir, stamp);
  fs.mkdirSync(outDir, { recursive: true });
  const htmlPath = path.join(outDir, "report.html");
  const jsonPath = path.join(outDir, "report.json");
  fs.writeFileSync(htmlPath, html(facts, topo, result));
  fs.writeFileSync(jsonPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    verdict: result.verdict,
    summary: result.summary,
    findings: result.findings,
    topology: { path: topo.present, l3Chain: topo.l3Chain, bridges: topo.bridges, target: topo.target },
    segments: result.segments.map((s) => ({ ...s, probe: s.probe || null })),
    facts: scrub(facts),
  }, null, 2));
  return { dir: outDir, html: htmlPath, json: jsonPath };
}

module.exports = { write, html, scrub, VERDICT_TEXT };
