/* Testbed troubleshooter — front end. Vanilla JS, no build step. */

"use strict";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;")
  .replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const ROLES = [
  { role: "client", label: "Client", required: true, hint: "traffic source" },
  { role: "spoke", label: "Spoke", required: true, hint: "remote site router" },
  { role: "netem", label: "Netem", required: false, hint: "impairment VM — optional" },
  { role: "hub", label: "Hub", required: true, hint: "gateway site" },
  { role: "server", label: "Server", required: true, hint: "traffic destination" },
];

const VERDICT_TEXT = {
  L2: "LAYER 2 ISSUE",
  L3: "LAYER 3 ISSUE",
  ACCESS: "TESTBED NOT FULLY REACHABLE",
  HEALTHY: "NO FAULT FOUND",
  HEALTHY_WARN: "WORKING — WITH WARNINGS",
  INCONCLUSIVE: "INCONCLUSIVE",
};

let running = false;
let esxiSkipped = false;

/* --------------------------------------------------------- node card build */

function nodeCards() {
  $("nodeCards").innerHTML = ROLES.map((r) => `
    <div class="nodecard" id="card_${r.role}">
      <h4>${r.label}
        <span class="tag">${r.required ? "required" : `<label class="inline"><input type="checkbox" id="n_${r.role}_enabled"> include</label>`}</span>
      </h4>
      <label>ESXi VM name</label>
      <input id="n_${r.role}_vmName" list="vmlist" placeholder="optional — improves L2 matching">
      <label>Management IP (SSH)</label><input id="n_${r.role}_host" placeholder="172.16.226.x">
      <div class="err" id="e_${r.role}_host"></div>
      <label>Username</label><input id="n_${r.role}_user" placeholder="root">
      <div class="err" id="e_${r.role}_user"></div>
      <label>Password</label><input id="n_${r.role}_pass" type="password">
      <div class="err" id="e_${r.role}_pass"></div>
      <label>or key path</label><input id="n_${r.role}_key">
      <label>Data-plane IP <span class="mut">(${r.hint})</span></label>
      <input id="n_${r.role}_dataIp" placeholder="optional">
      <div class="err" id="e_${r.role}_dataIp"></div>
    </div>`).join("");

  for (const r of ROLES.filter((x) => !x.required)) {
    const cb = $(`n_${r.role}_enabled`);
    const sync = () => $(`card_${r.role}`).classList.toggle("off", !cb.checked);
    cb.addEventListener("change", sync);
    sync();
  }
}

function collectConfig() {
  const cfg = {
    esxi: {
      host: $("esxiHost").value.trim(),
      user: $("esxiUser").value.trim(),
      pass: $("esxiPass").value,
      key: $("esxiKey").value.trim(),
      skip: esxiSkipped,
    },
    nodes: {},
    options: {
      maxHops: parseInt($("optHops").value, 10) || 12,
      mtuBytes: parseInt($("optMtu").value, 10) || 1500,
      activeProbes: $("optActive").checked,
    },
  };
  for (const r of ROLES) {
    const enabled = r.required ? true : $(`n_${r.role}_enabled`).checked;
    cfg.nodes[r.role] = {
      enabled,
      vmName: $(`n_${r.role}_vmName`).value.trim(),
      host: $(`n_${r.role}_host`).value.trim(),
      user: $(`n_${r.role}_user`).value.trim(),
      pass: $(`n_${r.role}_pass`).value,
      key: $(`n_${r.role}_key`).value.trim(),
      dataIp: $(`n_${r.role}_dataIp`).value.trim(),
    };
  }
  return cfg;
}

function applyConfig(cfg) {
  if (!cfg) return;
  const e = cfg.esxi || {};
  $("esxiHost").value = e.host || "";
  $("esxiUser").value = e.user || "root";
  $("esxiKey").value = e.key || "";
  $("esxiPass").placeholder = e.passSet ? "saved — blank keeps it" : "—";
  for (const r of ROLES) {
    const n = (cfg.nodes || {})[r.role] || {};
    $(`n_${r.role}_vmName`).value = n.vmName || "";
    $(`n_${r.role}_host`).value = n.host || "";
    $(`n_${r.role}_user`).value = n.user || "";
    $(`n_${r.role}_key`).value = n.key || "";
    $(`n_${r.role}_dataIp`).value = n.dataIp || "";
    $(`n_${r.role}_pass`).placeholder = n.passSet ? "saved — blank keeps it" : "";
    if (!r.required) {
      const cb = $(`n_${r.role}_enabled`);
      cb.checked = n.enabled !== false && !!n.host;
      cb.dispatchEvent(new Event("change"));
    }
  }
  const o = cfg.options || {};
  if (o.maxHops) $("optHops").value = o.maxHops;
  if (o.mtuBytes) $("optMtu").value = o.mtuBytes;
  $("optActive").checked = o.activeProbes !== false;
}

/* ------------------------------------------------------------- navigation */

function goStep(n) {
  for (const s of [1, 2, 3]) {
    $(`step${s}`).classList.toggle("on", s === n);
    const btn = document.querySelector(`.stepbtn[data-goto="${s}"]`);
    btn.classList.toggle("on", s === n);
  }
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function unlock(step) {
  document.querySelector(`.stepbtn[data-goto="${step}"]`).disabled = false;
}

/* ------------------------------------------------------------ step 1: ESXi */

async function esxiConnect() {
  const btn = $("esxiConnect");
  const msg = $("esxiMsg");
  btn.disabled = true;
  msg.className = "msg";
  msg.textContent = "connecting…";
  try {
    const r = await fetch("/api/esxi/inventory", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        esxi: {
          host: $("esxiHost").value.trim(),
          user: $("esxiUser").value.trim(),
          pass: $("esxiPass").value,
          key: $("esxiKey").value.trim(),
        },
      }),
    });
    const d = await r.json();
    if (!d.ok) throw new Error(d.error || "failed");
    esxiSkipped = false;
    renderEsxi(d);
    msg.className = "msg ok";
    msg.textContent = "connected";
    unlock(2);
  } catch (e) {
    msg.className = "msg bad";
    msg.textContent = e.message;
  } finally {
    btn.disabled = false;
  }
}

function renderEsxi(d) {
  $("esxiTitle").textContent = `${d.host} — ${d.version}`;
  $("esxiSummary").textContent =
    `${d.vswitches.length} vSwitch(es) · ${d.portgroups.length} portgroup(s) · ${d.vms.length} VM(s) registered`;
  const rows = d.vswitches.map((v) => {
    const pgs = d.portgroups.filter((p) => p.vswitch === v.name)
      .map((p) => `${esc(p.name)}${p.vlan === null ? "" : ` <span class="mut">(VLAN ${p.vlan})</span>`}`)
      .join(", ") || "—";
    return `<tr><td>${esc(v.name)} <span class="mut">${esc(v.kind)}</span></td><td>${esc(v.mtu)}</td>
      <td>${esc((v.uplinks || []).join(", ") || "none")}</td><td>${pgs}</td></tr>`;
  }).join("");
  $("esxiTable").innerHTML =
    `<tr><th>vSwitch</th><th>MTU</th><th>Uplinks</th><th>Portgroups</th></tr>${rows}`;
  $("vmlist").innerHTML = d.vms.map((v) => `<option value="${esc(v)}">`).join("");
  $("esxiPanel").classList.remove("hidden");

  // pre-fill VM names by role keyword when they are unambiguous
  for (const r of ROLES) {
    const field = $(`n_${r.role}_vmName`);
    if (field.value) continue;
    const hits = d.vms.filter((v) => v.toLowerCase().includes(r.role));
    if (hits.length === 1) field.value = hits[0];
  }
}

/* ------------------------------------------------------------- step 3: run */

function clearErrors() {
  document.querySelectorAll(".err").forEach((e) => { e.textContent = ""; });
  document.querySelectorAll("input.bad").forEach((e) => e.classList.remove("bad"));
  $("globalErr").textContent = "";
}

function showErrors(errors) {
  clearErrors();
  for (const [k, v] of Object.entries(errors || {})) {
    if (k === "_global") { $("globalErr").textContent = v; continue; }
    const [scope, field] = k.split(".");
    const box = $(`e_${scope}_${field}`);
    const input = $(`n_${scope}_${field}`) || $(`${scope}${field[0].toUpperCase()}${field.slice(1)}`);
    if (box) box.textContent = v;
    if (input) input.classList.add("bad");
    if (!box) $("globalErr").textContent += `${k}: ${v}  `;
  }
}

async function run() {
  clearErrors();
  // cleared before the POST: the server starts logging the moment it accepts,
  // and those first lines would otherwise be wiped by the reset below
  $("log").textContent = "";
  $("findings").innerHTML = "Collecting…";
  $("reportLink").classList.add("hidden");
  const r = await fetch("/api/diagnose", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(collectConfig()),
  });
  const d = await r.json();
  if (!d.ok) {
    showErrors(d.errors || { _global: d.error || "could not start" });
    goStep(2);
    return;
  }
  unlock(3);
  goStep(3);
}

/* ---------------------------------------------------------------- renderers */

function verdictBox(status) {
  const box = $("verdict");
  if (running) {
    box.className = "verdict run";
    $("verdictText").textContent = "Diagnosing…";
    $("verdictSummary").textContent = status.step || "";
    return;
  }
  if (status.phase === "error") {
    box.className = "verdict INCONCLUSIVE";
    $("verdictText").textContent = "RUN FAILED";
    $("verdictSummary").textContent = status.error || "";
    return;
  }
  if (!status.verdict) {
    box.className = "verdict idle";
    $("verdictText").textContent = "Waiting…";
    $("verdictSummary").textContent = "";
    return;
  }
  box.className = `verdict ${status.verdict}`;
  $("verdictText").textContent = VERDICT_TEXT[status.verdict] || status.verdict;
  $("verdictSummary").textContent = status.summary || "";
}

const LABEL = { client: "Client", spoke: "Spoke", netem: "Netem", hub: "Hub", server: "Server" };

function segFor(left, right, segments) {
  return (segments || []).find((s) =>
    (s.a === left || (s.viaBridge || []).includes(left)) &&
    (s.b === right || (s.viaBridge || []).includes(right)));
}

function renderPath(status) {
  const path = (status.topology && status.topology.path) || [];
  if (!path.length) { $("pathView").innerHTML = '<span class="mut">—</span>'; return; }
  const nodes = status.nodes || {};
  const parts = [];
  path.forEach((role, i) => {
    const n = nodes[role] || {};
    parts.push(`<span class="n${n.reachable === false ? " dead" : ""}">
      <b>${LABEL[role]}</b><span>${esc(n.host || "")}</span>
      ${n.kind ? `<span>${esc(n.kind)}${n.netemActive ? " · netem" : ""}</span>` : ""}</span>`);
    if (i < path.length - 1) {
      const seg = segFor(role, path[i + 1], status.segments);
      const st = seg ? seg.status : "unknown";
      const glyph = { ok: "──▶", l2: "──✕", l3: "──✕", filtered: "──▲", unknown: "──?" }[st] || "──?";
      parts.push(`<span class="lnk ${st}">${glyph}<small>${st === "ok" ? "" : esc(st.toUpperCase())}</small></span>`);
    }
  });
  $("pathView").innerHTML = parts.join("");
}

function renderFindings(status) {
  const f = status.findings || [];
  $("findCount").textContent = f.length ? `(${f.filter((x) => x.severity === "critical").length} critical, ${f.length} total)` : "";
  if (!f.length) {
    $("findings").innerHTML = status.phase === "done"
      ? '<p class="ok">No findings — every segment resolved ARP and every hop has a route.</p>'
      : "Nothing yet.";
    return;
  }
  $("findings").innerHTML = f.map((x, i) => `
    <div class="card ${esc(x.severity)}">
      <div class="cardhead">
        <span class="tag ${esc(x.layer)}">${esc(x.layer)}</span>
        ${x.severity === x.layer ? "" : `<span class="tag sev-${esc(x.severity)}">${esc(x.severity)}</span>`}
        <b>${i + 1}. ${esc(x.title)}</b><span class="mut">— ${esc(x.where)}</span>
      </div>
      <p>${esc(x.detail)}</p>
      ${x.evidence ? `<pre>${esc(x.evidence)}</pre>` : ""}
      ${x.remediation ? `<p class="fix"><b>Fix:</b> ${esc(x.remediation)}</p>` : ""}
      <div class="mut mono">${esc(x.id)}</div>
    </div>`).join("");
}

function renderSegments(status) {
  const segs = status.segments || [];
  if (!segs.length) { $("segTable").innerHTML = '<tr><td class="mut">Nothing yet.</td></tr>'; return; }
  const cls = { ok: "ok", l2: "bad", l3: "bad", filtered: "warn", unknown: "warn" };
  $("segTable").innerHTML =
    `<tr><th>Segment</th><th>Subnet</th><th>A</th><th>A portgroup</th><th>B</th><th>B portgroup</th>
     <th>Same L2 domain</th><th>ARP</th><th>Loss</th><th>Status</th></tr>` +
    segs.map((s) => `<tr>
      <td>${LABEL[s.a]} → ${LABEL[s.b]}${(s.viaBridge || []).length
        ? ` <span class="mut">via ${esc(s.viaBridge.join(","))}</span>` : ""}</td>
      <td>${esc(s.subnet || "—")}</td>
      <td>${esc(s.aIp || "—")}${s.aIface ? ` <span class="mut">${esc(s.aIface)}</span>` : ""}</td>
      <td>${esc(s.aPortgroup || "—")}${s.aVswitch ? ` <span class="mut">/${esc(s.aVswitch)}</span>` : ""}</td>
      <td>${esc(s.bIp || "—")}${s.bIface ? ` <span class="mut">${esc(s.bIface)}</span>` : ""}</td>
      <td>${esc(s.bPortgroup || "—")}${s.bVswitch ? ` <span class="mut">/${esc(s.bVswitch)}</span>` : ""}</td>
      <td>${s.sameL2Domain === null || s.sameL2Domain === undefined ? "unknown" : s.sameL2Domain ? "yes" : "<b class='bad'>no</b>"}</td>
      <td>${esc(s.arp || "—")}</td>
      <td>${s.lossPct === null || s.lossPct === undefined ? "—" : esc(s.lossPct + "%")}</td>
      <td class="${cls[s.status] || ""}">${esc((s.status || "unknown").toUpperCase())}</td>
    </tr>`).join("");
}

function renderNodes(status) {
  const nodes = status.nodes || {};
  const roles = Object.keys(nodes);
  if (!roles.length) { $("nodeTable").innerHTML = '<tr><td class="mut">Nothing yet.</td></tr>'; return; }
  $("nodeTable").innerHTML =
    `<tr><th>Role</th><th>Management</th><th>Reachable / hostname</th><th>Kind</th><th>Addresses</th>
     <th>vNIC → portgroup</th></tr>` +
    ROLES.filter((r) => nodes[r.role]).map((r) => {
      const n = nodes[r.role];
      return `<tr><td>${r.label}</td><td class="mono">${esc(n.host)}</td>
        <td class="${n.reachable ? "ok" : "bad"}">${n.reachable ? esc(n.hostname || "yes") : esc(n.error || "no")}</td>
        <td>${esc(n.kind || "—")}${n.netemActive ? ' <span class="mut">netem</span>' : ""}</td>
        <td class="mono">${(n.addrs || []).map(esc).join("<br>") || "—"}</td>
        <td class="mono">${(n.ports || []).map(esc).join("<br>") || "—"}</td></tr>`;
    }).join("");
}

function renderStatus(payload) {
  running = payload.running;
  const s = payload.status || {};
  $("sPhase").textContent = s.phase || "idle";
  $("sStep").textContent = s.step || "—";
  const t = s.topology || {};
  $("sFlow").textContent = t.srcIp && t.dstIp ? `${t.srcIp} → ${t.dstIp}` : "—";
  $("sReport").textContent = s.reportPath || "—";
  $("abortBtn").disabled = !running;
  $("runBtn").disabled = running;
  $("rerunBtn").disabled = running;
  if (s.reportPath) {
    $("reportLink").href = `/report?file=${encodeURIComponent(s.reportPath)}`;
    $("reportLink").classList.remove("hidden");
  }
  verdictBox(s);
  renderPath(s);
  renderFindings(s);
  renderSegments(s);
  renderNodes(s);
}

/* -------------------------------------------------------------- profiles */

async function refreshProfiles(names) {
  const list = names || (await (await fetch("/api/profiles")).json()).names || [];
  $("profSel").innerHTML = '<option value="">— select —</option>' +
    list.map((n) => `<option>${esc(n)}</option>`).join("");
}

/* ------------------------------------------------------------------ wiring */

function wire() {
  document.querySelectorAll("[data-goto]").forEach((b) =>
    b.addEventListener("click", () => goStep(parseInt(b.dataset.goto, 10))));

  $("esxiConnect").addEventListener("click", esxiConnect);
  $("esxiSkip").addEventListener("click", () => {
    esxiSkipped = true;
    $("esxiMsg").className = "msg";
    $("esxiMsg").textContent = "skipped — L2 verdict will rest on in-guest evidence only";
    unlock(2);
    goStep(2);
  });
  $("toStep2").addEventListener("click", () => goStep(2));
  $("runBtn").addEventListener("click", run);
  $("rerunBtn").addEventListener("click", run);
  $("abortBtn").addEventListener("click", () => fetch("/api/abort", { method: "POST" }));

  $("profLoad").addEventListener("click", async () => {
    const name = $("profSel").value;
    $("profErr").textContent = "";
    if (!name) { $("profErr").textContent = "pick a profile first"; return; }
    const d = await (await fetch(`/api/profiles?name=${encodeURIComponent(name)}`)).json();
    if (!d.ok) { $("profErr").textContent = d.error; return; }
    applyConfig(d.config);
  });
  $("profSave").addEventListener("click", async () => {
    const name = prompt("Save this configuration as:");
    if (!name) return;
    const d = await (await fetch("/api/profiles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, config: collectConfig() }),
    })).json();
    $("profErr").textContent = d.ok ? "" : d.error;
    if (d.ok) { await refreshProfiles(d.names); $("profSel").value = name; }
  });
  $("profDel").addEventListener("click", async () => {
    const name = $("profSel").value;
    if (!name || !confirm(`Delete profile "${name}"?`)) return;
    const d = await (await fetch(`/api/profiles?name=${encodeURIComponent(name)}`, { method: "DELETE" })).json();
    await refreshProfiles(d.names);
  });

  const ev = new EventSource("/api/events");
  ev.addEventListener("status", (e) => renderStatus(JSON.parse(e.data)));
  ev.addEventListener("log", (e) => {
    const box = $("log");
    const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 20;
    box.textContent += JSON.parse(e.data) + "\n";
    if (atBottom) box.scrollTop = box.scrollHeight;
  });
}

async function init() {
  nodeCards();
  wire();
  const d = await (await fetch("/api/defaults")).json();
  applyConfig(d.config);
  await refreshProfiles(d.profiles);
  const st = await (await fetch("/api/status")).json();
  renderStatus(st);
  if ((d.config.nodes || {}).client && d.config.nodes.client.host) unlock(2);
  if (st.status && st.status.verdict) unlock(3);
}

init();
