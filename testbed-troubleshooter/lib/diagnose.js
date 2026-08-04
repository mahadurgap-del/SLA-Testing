/**
 * Decision engine — pure functions over collected facts, no I/O.
 *
 * How the L2 / L3 call is made (this is the whole point of the tool):
 *
 *   The testbed is a chain:  client -> spoke -> [netem] -> hub -> server.
 *   For every adjacent pair we know two independent things:
 *     (a) whether the two vNICs share an L2 broadcast domain, from ESXi
 *         (same portgroup, or same vSwitch + same VLAN, or bridged together
 *          inside a netem VM) — computed with a union-find over portgroups;
 *     (b) whether the two IPs share a subnet, from the guests.
 *
 *   same subnet + different L2 domain -> L2 fault (portgroup / VLAN mismatch)
 *   same L2 domain + no shared subnet -> L3 fault (addressing)
 *   both agree, but ARP does not resolve -> L2 fault, and the sub-cause is
 *       ranked: link down > MAC changes rejected while the guest spoofs a MAC
 *       (the classic bridged-netem trap) > duplicate MAC > no reply
 *   ARP resolves to the wrong MAC -> L2 fault (MAC mismatch: duplicate IP or a
 *       stale/hijacked entry)
 *   ARP resolves, ICMP does not pass -> not L2; filtering or rp_filter
 *   every segment clean but end to end fails -> L3: walk the chain and name the
 *       node that lacks the route / has forwarding off / drops in FORWARD, and
 *       corroborate with the last responding traceroute hop.
 *
 * Findings are { id, layer, severity, where, title, detail, evidence,
 * remediation } and the verdict is the earliest failing layer along the path.
 */

"use strict";

const { sameSubnet, inSubnet, cidrOf } = require("./ipmath");
const esxiLib = require("./esxi");

const ROLE_ORDER = ["client", "spoke", "netem", "hub", "server"];
const ROLE_LABEL = { client: "Client", spoke: "Spoke", netem: "Netem", hub: "Hub", server: "Server" };

/* ------------------------------------------------------- L2 fabric (ESXi) */

function portKey(port) {
  if (!port) return null;
  return `${port.vswitch || "?"}||${port.portgroup || "?"}`;
}

/**
 * Union-find over portgroups. Merges:
 *   - portgroups on the same vSwitch carrying the same VLAN ID
 *   - VLAN 4095 (trunk) portgroups with every portgroup on that vSwitch
 *   - portgroups bridged together inside a guest (netem in bridge mode)
 */
function buildL2Fabric(esxi, nodes) {
  const parent = new Map();
  const find = (k) => {
    if (!parent.has(k)) parent.set(k, k);
    let r = k;
    while (parent.get(r) !== r) r = parent.get(r);
    let c = k;
    while (parent.get(c) !== c) { const n = parent.get(c); parent.set(c, r); c = n; }
    return r;
  };
  const union = (a, b) => {
    if (!a || !b) return;
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  const merges = [];

  const pgs = esxi && esxi.ok ? esxi.portgroups : [];
  for (const pg of pgs) find(`${pg.vswitch || "?"}||${pg.name}`);

  for (const a of pgs) {
    for (const b of pgs) {
      if (a === b || a.vswitch !== b.vswitch || !a.vswitch) continue;
      const trunk = a.vlan === 4095 || b.vlan === 4095;
      if (trunk || (a.vlan !== null && b.vlan !== null && a.vlan === b.vlan)) {
        union(`${a.vswitch}||${a.name}`, `${b.vswitch}||${b.name}`);
        merges.push(`${a.name} + ${b.name} (same vSwitch ${a.vswitch}, VLAN ${trunk ? "trunk" : a.vlan})`);
      }
    }
  }

  // guest bridges stitch their member ports into one domain
  for (const node of Object.values(nodes || {})) {
    if (!node || !node.reachable) continue;
    for (const br of node.bridges || []) {
      const keys = br.members
        .map((m) => portKey((node.ifacePorts || {})[m]))
        .filter(Boolean);
      for (let i = 1; i < keys.length; i++) {
        union(keys[0], keys[i]);
        merges.push(`${keys[0].split("||")[1]} + ${keys[i].split("||")[1]} (bridged by ${node.role} ${br.name})`);
      }
    }
  }

  return {
    known: pgs.length > 0,
    /** true / false / null (unknown — one side has no ESXi port match) */
    same(pa, pb) {
      const ka = portKey(pa);
      const kb = portKey(pb);
      if (!ka || !kb) return null;
      if (ka === kb) return true;
      return find(ka) === find(kb);
    },
    domain(port) {
      const k = portKey(port);
      return k ? find(k) : null;
    },
    merges,
  };
}

/** Match each guest interface to the ESXi vNIC port with the same MAC. */
function attachEsxiPorts(facts) {
  const esxi = facts.esxi;
  const ports = esxiLib.allPorts(esxi);
  for (const node of Object.values(facts.nodes)) {
    node.ifacePorts = {};
    node.esxiVm = esxiLib.findVm(esxi, node.vmName) || null;
    if (!node.reachable) continue;
    const scope = node.esxiVm ? node.esxiVm.ports.map((p) => ({ ...p, vm: node.esxiVm.name })) : ports;
    for (const link of node.links || []) {
      if (!link.mac) continue;
      const hit = scope.find((p) => p.mac && p.mac === link.mac) ||
                  ports.find((p) => p.mac && p.mac === link.mac);
      if (hit) node.ifacePorts[link.iface] = hit;
    }
    // a vNIC whose guest MAC was changed (bridge / netem) has no MAC match:
    // fall back to positional mapping within the VM when counts line up
    if (node.esxiVm) {
      const unmatched = (node.links || []).filter((l) => !node.ifacePorts[l.iface] && l.kind !== "bridge");
      const freePorts = node.esxiVm.ports.filter(
        (p) => !Object.values(node.ifacePorts).some((q) => q.portId === p.portId));
      if (unmatched.length && unmatched.length === freePorts.length) {
        unmatched.forEach((l, i) => {
          node.ifacePorts[l.iface] = { ...freePorts[i], vm: node.esxiVm.name, macMatched: false };
        });
      }
    }
  }
}

/* ------------------------------------------------------------- node roles */

function dataAddrs(node) {
  return (node.addrs || []).map((a) => ({
    ...a,
    isMgmt: a.ip === node.host,
    isData: !!node.dataIp && a.ip === node.dataIp,
  }));
}

/** "bridge" (transparent L2), "router" (forwards between subnets) or "host". */
function classifyNode(node) {
  if (!node || !node.reachable) return "unknown";
  const brs = (node.bridges || []).filter((b) => b.members.length >= 2);
  if (brs.length) {
    const bridged = new Set(brs.map((b) => b.name));
    const hasIpOnBridge = (node.addrs || []).some((a) => bridged.has(a.iface) && a.ip !== node.host);
    if (!hasIpOnBridge) return "bridge";
  }
  const nets = new Set(
    dataAddrs(node).filter((a) => !a.isMgmt).map((a) => cidrOf(a.ip, a.prefix)).filter(Boolean));
  if (node.ipForward && nets.size >= 2) return "router";
  return "host";
}

/* ------------------------------------------------------------- topology */

function scoreAddrPair(a, b, nodeA, nodeB) {
  let s = 0;
  if (a.isData) s += 4;
  if (b.isData) s += 4;
  if (!a.isMgmt) s += 2;
  if (!b.isMgmt) s += 2;
  if ((nodeA.ifacePorts || {})[a.iface]) s += 1;
  if ((nodeB.ifacePorts || {})[b.iface]) s += 1;
  return s;
}

/**
 * The shared subnet that makes two nodes L3 neighbours.
 *
 * Data-plane addresses win outright. When both nodes have a data address but
 * none of them line up we return null rather than falling back to the
 * management subnet — the management LAN is shared by every VM, and quietly
 * matching on it would hide exactly the addressing fault we are looking for.
 * The fallback only applies to a node that has no data address at all.
 */
function pickAddrPair(nodeA, nodeB) {
  const A = dataAddrs(nodeA);
  const B = dataAddrs(nodeB);
  const pairs = [];
  for (const a of A) {
    for (const b of B) {
      if (sameSubnet(a, b)) pairs.push({ a, b, score: scoreAddrPair(a, b, nodeA, nodeB) });
    }
  }
  const best = (list) => list.reduce((m, p) => (!m || p.score > m.score ? p : m), null);
  const onData = pairs.filter((p) => !p.a.isMgmt && !p.b.isMgmt);
  if (onData.length) return best(onData);
  if (A.some((a) => !a.isMgmt) && B.some((b) => !b.isMgmt)) return null;
  return pairs.length ? best(pairs) : null;
}

/**
 * Physical chain (all provided roles, in order) plus the L3 chain, which has
 * transparent bridges collapsed out — a bridging netem VM is not a hop.
 */
function buildTopology(facts) {
  const present = ROLE_ORDER.filter((r) => facts.nodes[r]);
  for (const r of present) facts.nodes[r].kind = classifyNode(facts.nodes[r]);

  const l3Chain = present.filter((r) => facts.nodes[r].kind !== "bridge");
  const bridges = present.filter((r) => facts.nodes[r].kind === "bridge");

  const segments = [];
  for (let i = 0; i < l3Chain.length - 1; i++) {
    const ra = l3Chain[i];
    const rb = l3Chain[i + 1];
    const nodeA = facts.nodes[ra];
    const nodeB = facts.nodes[rb];
    const pair = nodeA.reachable && nodeB.reachable ? pickAddrPair(nodeA, nodeB) : null;
    // any bridge role that sits physically between these two
    const between = bridges.filter((br) => {
      const bi = present.indexOf(br);
      return bi > present.indexOf(ra) && bi < present.indexOf(rb);
    });
    segments.push({
      key: `${ra}->${rb}`,
      a: ra,
      b: rb,
      viaBridge: between,
      aAddr: pair ? pair.a : null,
      bAddr: pair ? pair.b : null,
      subnet: pair ? cidrOf(pair.a.ip, pair.a.prefix) : null,
      onMgmt: pair ? pair.a.isMgmt || pair.b.isMgmt : false,
    });
  }

  const src = facts.nodes.client
    ? facts.nodes.client.dataIp || bestSourceIp(facts.nodes.client, segments) || facts.nodes.client.host
    : null;
  const dst = facts.nodes.server
    ? facts.nodes.server.dataIp || bestTargetIp(facts.nodes.server, segments) || facts.nodes.server.host
    : null;

  return {
    present,
    l3Chain,
    bridges,
    segments,
    transit: l3Chain.slice(1, -1),
    target: { srcIp: src, dstIp: dst },
  };
}

function bestSourceIp(node, segments) {
  const seg = segments.find((s) => s.a === node.role && s.aAddr);
  return seg ? seg.aAddr.ip : null;
}

function bestTargetIp(node, segments) {
  const seg = [...segments].reverse().find((s) => s.b === node.role && s.bAddr);
  return seg ? seg.bAddr.ip : null;
}

/* ------------------------------------------------------------- findings */

function finding(f) {
  return {
    severity: "critical",
    layer: "L2",
    evidence: "",
    remediation: "",
    ...f,
  };
}

const ARP_GOOD = ["REACHABLE", "STALE", "DELAY", "PROBE", "PERMANENT", "NOARP"];

function arpResolved(probe) {
  if (!probe) return null;
  if (probe.arping && probe.arping.ok) return true;
  const n = probe.neigh;
  if (n && n.mac && ARP_GOOD.includes(n.state)) return true;
  if (n && n.mac && n.state === "") return true; // some kernels print no state
  if (n && (n.state === "FAILED" || n.state === "INCOMPLETE")) return false;
  if (!n) return false;
  return !!n.mac;
}

function macsOf(node) {
  const set = new Set();
  for (const l of node.links || []) if (l.mac) set.add(l.mac);
  for (const p of Object.values(node.ifacePorts || {})) if (p.mac) set.add(p.mac);
  return set;
}

function ifaceOf(node, ip) {
  const a = (node.addrs || []).find((x) => x.ip === ip);
  return a ? a.iface : null;
}

/**
 * The node's matched ESXi ports that could carry test traffic — everything
 * except the interface holding its management address.
 */
function dataPorts(node) {
  const mgmt = new Set((node.addrs || []).filter((a) => a.ip === node.host).map((a) => a.iface));
  return Object.entries(node.ifacePorts || {})
    .filter(([iface]) => !mgmt.has(iface))
    .map(([iface, port]) => ({ iface, port }));
}

function portDesc(node, iface) {
  const p = (node.ifacePorts || {})[iface];
  if (!p) return `${iface} (no ESXi vNIC matched)`;
  return `${iface} -> portgroup "${p.portgroup}" on ${p.vswitch}`;
}

function vlanOf(esxi, port) {
  const pg = esxiLib.portgroupInfo(esxi, port && port.portgroup);
  return pg && pg.vlan !== null && pg.vlan !== undefined ? pg.vlan : null;
}

/* ------------------------------------------------------------ L2 analysis */

function analyzeL2(facts, topo, fabric) {
  const out = [];
  const esxi = facts.esxi;

  /* -- host-wide: duplicate MACs ------------------------------------------ */
  const seen = new Map();
  for (const p of esxiLib.allPorts(esxi)) {
    if (!p.mac) continue;
    const prev = seen.get(p.mac);
    if (prev && prev.vm !== p.vm) {
      out.push(finding({
        id: "l2.duplicate-mac",
        where: `${prev.vm} / ${p.vm}`,
        title: "Duplicate MAC address on two vNICs",
        detail: `MAC ${p.mac} is configured on both "${prev.vm}" (port ${prev.portId}) and ` +
          `"${p.vm}" (port ${p.portId}). The vSwitch forwarding table will flap between the two ports, ` +
          `so traffic reaches whichever VM last transmitted.`,
        evidence: `esxcli network vm port list: ${prev.vm} ${prev.mac} / ${p.vm} ${p.mac}`,
        remediation: "Give one of the vNICs a fresh MAC (Edit Settings -> Network adapter -> Advanced -> " +
          "Manual MAC, or set it back to Automatic) and power-cycle it.",
      }));
    }
    seen.set(p.mac, p);
  }

  /* -- per node: link state, MAC spoofing vs portgroup policy ------------- */
  for (const role of topo.present) {
    const node = facts.nodes[role];
    if (!node.reachable) {
      out.push(finding({
        id: "access.unreachable",
        layer: "access",
        where: ROLE_LABEL[role],
        title: `${ROLE_LABEL[role]} is unreachable over SSH`,
        detail: `Could not log in to ${node.host}: ${node.error}. Everything downstream of this node is ` +
          `analysed from the other end only.`,
        evidence: node.error || "",
        remediation: "Check the credentials, that sshd is running, and that the management interface is up.",
      }));
      continue;
    }

    const usedIfaces = new Set(
      topo.segments.flatMap((s) => [
        s.a === role && s.aAddr ? s.aAddr.iface : null,
        s.b === role && s.bAddr ? s.bAddr.iface : null,
      ]).filter(Boolean));
    for (const br of node.bridges || []) for (const m of br.members) usedIfaces.add(m);

    for (const link of node.links || []) {
      if (link.kind === "bridge") continue;
      const inPath = usedIfaces.has(link.iface);
      if (!link.carrier || link.state === "DOWN") {
        out.push(finding({
          id: "l2.link-down",
          severity: inPath ? "critical" : "warning",
          where: `${ROLE_LABEL[role]} ${link.iface}`,
          title: `Interface ${link.iface} is ${link.carrier ? "administratively down" : "down (NO-CARRIER)"}`,
          detail: link.carrier
            ? `${link.iface} is admin-down inside the guest, so nothing is transmitted on it.`
            : `${link.iface} has no carrier — the vNIC is disconnected at the ESXi level ` +
              `("Connected" / "Connect at power on" unchecked) or its portgroup no longer exists.`,
          evidence: `ip link: ${link.iface} state ${link.state} <${link.flags.join(",")}>` +
            ((node.ifacePorts || {})[link.iface] ? ` | ${portDesc(node, link.iface)}` : ""),
          remediation: link.carrier
            ? `Bring it up: sudo ip link set ${link.iface} up`
            : "Tick Connected on the VM's network adapter in vSphere, or re-point it at an existing portgroup.",
        }));
        continue;
      }

      const port = (node.ifacePorts || {})[link.iface];
      if (!port || !inPath) continue;
      const sec = esxiLib.securityFor(esxi, port);
      const spoofed = port.mac && link.mac && port.mac !== link.mac;
      if (spoofed && sec.macChanges === false) {
        out.push(finding({
          id: "l2.mac-mismatch-policy",
          where: `${ROLE_LABEL[role]} ${link.iface}`,
          title: "MAC mismatch — guest MAC differs from the vNIC MAC and the portgroup rejects it",
          detail: `The guest transmits with ${link.mac} but the vSwitch port owns ${port.mac}, and portgroup ` +
            `"${port.portgroup}" has MAC address changes = Reject. The vSwitch drops every frame from this ` +
            `interface, so the peer never learns the MAC and ARP stays unresolved.`,
          evidence: `guest ${link.iface} ${link.mac} vs vNIC ${port.mac}; policy macChanges=reject`,
          remediation: `Set MAC address changes = Accept and Forged transmits = Accept on "${port.portgroup}" ` +
            `(required for any bridging / netem VM), or set the guest MAC back to ${port.mac}.`,
        }));
      } else if (spoofed) {
        out.push(finding({
          id: "l2.mac-mismatch",
          severity: "warning",
          where: `${ROLE_LABEL[role]} ${link.iface}`,
          title: "MAC mismatch between guest and vNIC",
          detail: `The guest uses ${link.mac} on ${link.iface} while the vSwitch port is configured with ` +
            `${port.mac}. Intentional for a bridge; otherwise ARP entries elsewhere will point at the wrong MAC.`,
          evidence: `guest ${link.mac} vs vNIC ${port.mac} (portgroup "${port.portgroup}")`,
          remediation: "Expected on a netem bridge — otherwise remove the guest MAC override.",
        }));
      }
      if (link.mtu && port.portgroup) {
        const vs = esxiLib.vswitchInfo(esxi, port.vswitch);
        if (vs && vs.mtu && link.mtu > vs.mtu) {
          out.push(finding({
            id: "l2.mtu-mismatch",
            severity: "warning",
            where: `${ROLE_LABEL[role]} ${link.iface}`,
            title: `Guest MTU ${link.mtu} exceeds vSwitch ${vs.name} MTU ${vs.mtu}`,
            detail: `Frames larger than ${vs.mtu} bytes are dropped by the vSwitch. Small packets (ping) pass, ` +
              `bulk traffic stalls — the classic "ping works, iperf doesn't" signature.`,
            evidence: `guest mtu ${link.mtu} | vSwitch ${vs.name} mtu ${vs.mtu}`,
            remediation: `Raise the vSwitch/portgroup MTU to ${link.mtu} or lower the guest MTU to ${vs.mtu}.`,
          }));
        }
      }
    }
  }

  /* -- netem bridge sanity ------------------------------------------------ */
  for (const role of topo.bridges) {
    const node = facts.nodes[role];
    for (const br of node.bridges || []) {
      if (br.state === "DOWN") {
        out.push(finding({
          id: "l2.bridge-down",
          where: `${ROLE_LABEL[role]} ${br.name}`,
          title: `Bridge ${br.name} is down`,
          detail: `${role} bridges ${br.members.join(" + ")} but ${br.name} is state DOWN, so no frames cross it.`,
          evidence: `ip link: ${br.name} state ${br.state}; members ${br.members.join(", ")}`,
          remediation: `sudo ip link set ${br.name} up (and the members too)`,
        }));
      }
      for (const m of br.members) {
        const port = (node.ifacePorts || {})[m];
        if (!port) continue;
        const sec = esxiLib.securityFor(esxi, port);
        if (sec.forgedTransmits === false || sec.promiscuous === false) {
          out.push(finding({
            id: "l2.bridge-policy",
            severity: sec.forgedTransmits === false ? "critical" : "warning",
            where: `${ROLE_LABEL[role]} ${m}`,
            title: `Portgroup "${port.portgroup}" blocks bridged traffic`,
            detail: `${role} forwards frames for other MACs through ${m}, which needs Forged transmits = Accept ` +
              `(and Promiscuous = Accept when the bridge must also learn) on "${port.portgroup}". ` +
              `Currently forgedTransmits=${sec.forgedTransmits}, promiscuous=${sec.promiscuous}.`,
            evidence: `portgroup policy: promiscuous=${sec.promiscuous}, macChanges=${sec.macChanges}, ` +
              `forgedTransmits=${sec.forgedTransmits}`,
            remediation: `On "${port.portgroup}": Promiscuous mode = Accept, MAC address changes = Accept, ` +
              `Forged transmits = Accept.`,
          }));
        }
      }
    }
  }

  /* -- per segment: the portgroup / VLAN / ARP verdict -------------------- */
  for (const seg of topo.segments) {
    const nodeA = facts.nodes[seg.a];
    const nodeB = facts.nodes[seg.b];
    if (!nodeA.reachable || !nodeB.reachable) { seg.status = "unknown"; continue; }

    const portA = seg.aAddr ? (nodeA.ifacePorts || {})[seg.aAddr.iface] : null;
    const portB = seg.bAddr ? (nodeB.ifacePorts || {})[seg.bAddr.iface] : null;
    const sameDomain = fabric.same(portA, portB);
    seg.portA = portA || null;
    seg.portB = portB || null;
    seg.sameL2Domain = sameDomain;

    /* no shared subnet at all */
    if (!seg.subnet) {
      const aNets = dataAddrs(nodeA).filter((a) => !a.isMgmt).map((a) => a.cidr);
      const bNets = dataAddrs(nodeB).filter((a) => !a.isMgmt).map((a) => a.cidr);
      // there is no address pair to compare, so ask a wider question: do any of
      // the two nodes' data vNICs share a broadcast domain at all?
      const pa = dataPorts(nodeA);
      const pb = dataPorts(nodeB);
      let shared = null;
      for (const x of pa) {
        for (const y of pb) if (fabric.same(x.port, y.port) === true) { shared = [x, y]; break; }
        if (shared) break;
      }
      seg.sameL2Domain = shared ? true : (pa.length && pb.length ? false : null);
      if (shared) {
        seg.portA = shared[0].port;
        seg.portB = shared[1].port;
      }
      // adjacent in L2 (or unverifiable) but not in L3 -> addressing fault
      if (shared || !pa.length || !pb.length) {
        seg.status = "l3";
        out.push(finding({
          id: "l3.subnet-mismatch",
          layer: "L3",
          where: `${ROLE_LABEL[seg.a]} <-> ${ROLE_LABEL[seg.b]}`,
          title: shared ? "Same L2 segment, different subnets" : "Adjacent nodes have no common subnet",
          detail: (shared
            ? `${seg.a}'s ${shared[0].iface} and ${seg.b}'s ${shared[1].iface} sit in the same broadcast domain ` +
              `("${shared[0].port.portgroup}" / "${shared[1].port.portgroup}")`
            : `${seg.a} and ${seg.b} are meant to be neighbours`) +
            ` but have no common subnet (${aNets.join(", ") || "none"} vs ${bNets.join(", ") || "none"}), ` +
            `so they can never be L3 neighbours — every packet is punted to a gateway that is not there. ` +
            `Frames are delivered; the addressing is wrong.`,
          evidence: `${seg.a}: ${aNets.join(", ") || "no data IP"}` +
            (shared ? ` on "${shared[0].port.portgroup}"` : "") +
            ` | ${seg.b}: ${bNets.join(", ") || "no data IP"}` +
            (shared ? ` on "${shared[1].port.portgroup}"` : ""),
          remediation: `Re-address one side into the other's subnet (or add a matching secondary address), ` +
            `keeping the same prefix length.`,
        }));
      } else {
        seg.status = "l2";
        out.push(finding({
          id: "l2.no-adjacency",
          where: `${ROLE_LABEL[seg.a]} <-> ${ROLE_LABEL[seg.b]}`,
          title: "Neighbours are neither L2 adjacent nor in a common subnet",
          detail: `${seg.a}'s data vNIC(s) are on ${pa.map((x) => `"${x.port.portgroup}" (${x.port.vswitch})`).join(", ")} ` +
            `and ${seg.b}'s on ${pb.map((y) => `"${y.port.portgroup}" (${y.port.vswitch})`).join(", ")}; none of those ` +
            `pairs share a broadcast domain, and the two have no subnet in common either. This link does not exist yet.`,
          evidence: `${seg.a}: ${aNets.join(", ") || "no data IP"} on ${pa.map((x) => x.port.portgroup).join(", ")} | ` +
            `${seg.b}: ${bNets.join(", ") || "no data IP"} on ${pb.map((y) => y.port.portgroup).join(", ")}`,
          remediation: "Put both vNICs in the same portgroup (or same vSwitch + same VLAN) and address them " +
            "out of one subnet.",
        }));
      }
      continue;
    }

    /* shared subnet but split L2 — the headline portgroup / VLAN mismatch */
    if (sameDomain === false) {
      const vlanA = vlanOf(esxi, portA);
      const vlanB = vlanOf(esxi, portB);
      const sameSwitch = portA && portB && portA.vswitch === portB.vswitch;
      const vlanFault = sameSwitch && vlanA !== null && vlanB !== null && vlanA !== vlanB;
      seg.status = "l2";
      out.push(finding({
        id: vlanFault ? "l2.vlan-mismatch" : "l2.portgroup-mismatch",
        where: `${ROLE_LABEL[seg.a]} <-> ${ROLE_LABEL[seg.b]}`,
        title: vlanFault
          ? `VLAN mismatch on ${portA.vswitch}: VLAN ${vlanA} vs VLAN ${vlanB}`
          : "Portgroup mismatch — same subnet, different broadcast domains",
        detail: vlanFault
          ? `${seg.a} sits on "${portA.portgroup}" (VLAN ${vlanA}) and ${seg.b} on "${portB.portgroup}" ` +
            `(VLAN ${vlanB}) on the same vSwitch, yet both use ${seg.subnet}. The vSwitch tags them into ` +
            `separate broadcast domains, so ARP never completes.`
          : `Both ends are addressed in ${seg.subnet} — they are meant to be directly connected — but ` +
            `${portA ? `${seg.a} is plugged into "${portA.portgroup}" on ${portA.vswitch}` : `${seg.a} has no matched vNIC`} ` +
            `while ${portB ? `${seg.b} is on "${portB.portgroup}" on ${portB.vswitch}` : `${seg.b} has no matched vNIC`}. ` +
            `Those are different L2 domains, so the two never see each other's frames.`,
        evidence: `${seg.a}: ${seg.aAddr.ip}/${seg.aAddr.prefix} ${portDesc(nodeA, seg.aAddr.iface)}` +
          (vlanA !== null ? ` VLAN ${vlanA}` : "") +
          ` | ${seg.b}: ${seg.bAddr.ip}/${seg.bAddr.prefix} ${portDesc(nodeB, seg.bAddr.iface)}` +
          (vlanB !== null ? ` VLAN ${vlanB}` : ""),
        remediation: vlanFault
          ? `Set both portgroups to the same VLAN ID (or move both vNICs into one portgroup).`
          : `Move ${seg.b}'s ${seg.bAddr.iface} into "${portA ? portA.portgroup : "the same portgroup as " + seg.a}", ` +
            `or give the two portgroups the same vSwitch + VLAN ID.` +
            (topo.bridges.length ? " If a netem VM is meant to bridge these two portgroups, check that its " +
              "bridge is up and both members are enslaved." : ""),
      }));
      continue;
    }

    /* L2 domain agrees (or is unknown) — let the probes decide */
    const probe = (facts.probes.segments || {})[seg.key] || null;
    const resolved = arpResolved(probe);
    const learnedMac = probe && probe.neigh ? probe.neigh.mac : "";
    const peerMacs = macsOf(nodeB);
    const pingOk = probe && probe.ping ? probe.ping.ok : null;
    seg.probe = probe;

    if (resolved === false) {
      // rank the sub-cause using the evidence we already hold
      const peerLink = seg.bAddr ? (nodeB.links || []).find((l) => l.iface === seg.bAddr.iface) : null;
      const peerPortSec = esxiLib.securityFor(esxi, portB);
      let cause, fix;
      if (peerLink && (!peerLink.carrier || peerLink.state === "DOWN")) {
        cause = `${seg.b}'s ${peerLink.iface} is down, so it cannot answer ARP`;
        fix = `Bring ${seg.b}'s ${peerLink.iface} up and confirm the vNIC is Connected in vSphere.`;
      } else if (portB && peerLink && portB.mac && peerLink.mac && portB.mac !== peerLink.mac &&
                 peerPortSec.macChanges === false) {
        cause = `${seg.b} transmits with ${peerLink.mac} but "${portB.portgroup}" rejects MAC changes, ` +
          `so its ARP replies are dropped by the vSwitch`;
        fix = `Set MAC address changes = Accept and Forged transmits = Accept on "${portB.portgroup}".`;
      } else if (sameDomain === null) {
        cause = "ARP does not resolve and no ESXi vNIC could be matched to these interfaces, so the " +
          "portgroup mapping could not be verified";
        fix = "Confirm both vNICs are in the same portgroup / VLAN in vSphere (supply the VM names so the " +
          "tool can match them automatically).";
      } else {
        cause = `both ends are in ${seg.subnet} and share portgroup domain ` +
          `"${portA ? portA.portgroup : "?"}", yet no ARP reply arrives`;
        fix = `Check for a duplicate IP in ${seg.subnet}, an ARP/ebtables filter on ${seg.b}, and that ` +
          `${seg.b}'s interface is not in a VLAN sub-interface while ${seg.a} is untagged.`;
      }
      seg.status = "l2";
      out.push(finding({
        id: "l2.arp-unresolved",
        where: `${ROLE_LABEL[seg.a]} <-> ${ROLE_LABEL[seg.b]}`,
        title: `ARP does not resolve ${seg.bAddr.ip} from ${seg.a}`,
        detail: `L2 fault: ${cause}. Without a MAC there is no frame to send, so this is a layer-2 problem, ` +
          `not routing.`,
        evidence: `ip neigh ${seg.bAddr.ip}: ${probe && probe.neigh
          ? `${probe.neigh.state}${probe.neigh.mac ? " " + probe.neigh.mac : " (no lladdr)"}`
          : "no entry"}` +
          (probe && probe.arping ? ` | arping: ${probe.arping.ok ? "reply" : "no reply"}` : "") +
          ` | ping ${seg.bAddr.ip}: ${probe && probe.ping ? probe.ping.lossPct + "% loss" : "n/a"}`,
        remediation: fix,
      }));
      continue;
    }

    if (resolved === true && learnedMac && peerMacs.size && !peerMacs.has(learnedMac)) {
      seg.status = "l2";
      out.push(finding({
        id: "l2.wrong-mac",
        where: `${ROLE_LABEL[seg.a]} <-> ${ROLE_LABEL[seg.b]}`,
        title: "MAC mismatch — the ARP reply comes from a different machine",
        detail: `${seg.a} resolved ${seg.bAddr.ip} to ${learnedMac}, but ${seg.b} owns ` +
          `${[...peerMacs].join(", ")}. Something else in ${seg.subnet} is answering for that address ` +
          `(duplicate IP, a stale entry, or a second VM in the same portgroup).`,
        evidence: `ip neigh: ${seg.bAddr.ip} lladdr ${learnedMac} (${probe.neigh.state}) | ` +
          `${seg.b} MACs: ${[...peerMacs].join(", ")}`,
        remediation: `Flush the entry (sudo ip neigh flush ${seg.bAddr.ip}) and re-test; if it comes back wrong, ` +
          `find the duplicate: arping -D -I ${seg.aAddr.iface} ${seg.bAddr.ip} from ${seg.a}.`,
      }));
      continue;
    }

    if (resolved === true && pingOk === false) {
      seg.status = "filtered";
      const fw = nodeB.firewall;
      const dropping = fw && (fw.policies.INPUT === "DROP" || fw.dropRules.length > 0);
      out.push(finding({
        id: "l3.segment-filtered",
        layer: "L3",
        where: `${ROLE_LABEL[seg.a]} <-> ${ROLE_LABEL[seg.b]}`,
        title: `L2 is fine, but ${seg.bAddr.ip} does not answer ICMP`,
        detail: `ARP resolved ${seg.bAddr.ip} to ${learnedMac || "a MAC"}, which proves the portgroup and VLAN ` +
          `are correct — frames are being delivered. The loss is above L2: ` +
          (dropping
            ? `${seg.b} has INPUT policy ${fw.policies.INPUT} with ${fw.dropRules.length} drop/reject rule(s).`
            : `most likely an ICMP filter or rp_filter on ${seg.b}.`),
        evidence: `ping: ${probe.ping.lossPct}% loss | neigh ${probe.neigh ? probe.neigh.state : "?"} ` +
          (dropping ? `| iptables -P INPUT ${fw.policies.INPUT}` : ""),
        remediation: `On ${seg.b}: sudo iptables -S | grep -E 'INPUT|icmp' and allow ICMP from ${seg.subnet}; ` +
          `also check net.ipv4.conf.${seg.bAddr.iface}.rp_filter.`,
      }));
      continue;
    }

    seg.status = resolved === true && pingOk ? "ok" : "unknown";
    if (seg.onMgmt && seg.status === "ok") {
      out.push(finding({
        id: "info.mgmt-segment",
        layer: "info",
        severity: "info",
        where: `${ROLE_LABEL[seg.a]} <-> ${ROLE_LABEL[seg.b]}`,
        title: "This adjacency was matched on the management network",
        detail: `The only shared subnet between ${seg.a} and ${seg.b} is ${seg.subnet}, which carries their SSH ` +
          `management addresses. The data path may be a different segment that is not configured yet.`,
        evidence: `${seg.aAddr.ip} <-> ${seg.bAddr.ip} on ${seg.subnet}`,
        remediation: "Fill in the per-node data-plane IPs so the real test path is analysed.",
      }));
    }
  }

  /* -- uplink state, only where the segment must leave the host ----------- */
  const usedVswitches = new Set(topo.segments.flatMap((s) =>
    [s.portA, s.portB].filter(Boolean).map((p) => p.vswitch)));
  for (const vsName of usedVswitches) {
    const vs = esxiLib.vswitchInfo(esxi, vsName);
    if (!vs || !vs.uplinks.length) continue;
    const down = vs.uplinks.filter((u) => {
      const n = (esxi.pnics || []).find((p) => p.name === u);
      return n && !n.linkUp;
    });
    if (down.length === vs.uplinks.length) {
      out.push(finding({
        id: "l2.uplink-down",
        severity: "warning",
        where: vsName,
        title: `All uplinks of ${vsName} are down (${down.join(", ")})`,
        detail: `Intra-host traffic still switches locally, so this only breaks the path if either end of a ` +
          `segment lives on another ESXi host or a physical device.`,
        evidence: down.map((d) => `${d}: link down`).join("; "),
        remediation: "Check the physical cabling / upstream switch port, or ignore if the whole testbed is on this host.",
      }));
    }
  }

  return out;
}

/* ------------------------------------------------------------ L3 analysis */

function nodeOwningIp(facts, ip) {
  for (const [role, node] of Object.entries(facts.nodes)) {
    if ((node.addrs || []).some((a) => a.ip === ip)) return role;
  }
  return null;
}

function analyzeL3(facts, topo) {
  const out = [];
  const { srcIp, dstIp } = topo.target;
  // segments the L2 pass already condemned: anything downstream of one of these
  // is a consequence, not an independent routing fault, and is reported as
  // corroboration so the finding list keeps one cause per problem
  const l2Broken = new Set(topo.segments.filter((s) => s.status === "l2").map((s) => s.key));
  const e2e = facts.probes.endToEnd || {};
  const routeGets = facts.probes.routeGets || {};
  const client = facts.nodes.client;
  const server = facts.nodes.server;
  if (!client || !server || !srcIp || !dstIp) return out;

  const srcAddr = (client.addrs || []).find((a) => a.ip === srcIp) || null;
  const srcSubnet = srcAddr ? cidrOf(srcAddr.ip, srcAddr.prefix) : null;

  /* forwarding disabled on a transit node — the single most common cause */
  for (const role of topo.transit) {
    const node = facts.nodes[role];
    if (!node.reachable) continue;
    if (node.ipForward === false) {
      out.push(finding({
        id: "l3.forwarding-disabled",
        layer: "L3",
        where: ROLE_LABEL[role],
        title: `IPv4 forwarding is disabled on ${role}`,
        detail: `${role} is a transit hop between ${topo.l3Chain[0]} and ${topo.l3Chain[topo.l3Chain.length - 1]}, ` +
          `but net.ipv4.ip_forward = 0, so it accepts packets for itself and silently discards everything it ` +
          `should route. Routing stops here.`,
        evidence: "/proc/sys/net/ipv4/ip_forward = 0",
        remediation: `sudo sysctl -w net.ipv4.ip_forward=1 (persist in /etc/sysctl.d/99-lab.conf)`,
      }));
    }
  }

  /* route toward the destination, hop by hop */
  for (let i = 0; i < topo.l3Chain.length - 1; i++) {
    const role = topo.l3Chain[i];
    const node = facts.nodes[role];
    if (!node.reachable) continue;
    const rg = (routeGets[role] || {}).toDst;
    if (!rg) continue;
    if (rg.unreachable) {
      out.push(finding({
        id: "l3.no-route",
        layer: "L3",
        where: ROLE_LABEL[role],
        title: `${role} has no route to ${dstIp}`,
        detail: `ip route get ${dstIp} fails on ${role}: there is no matching prefix and no default gateway ` +
          `covering it. Routing lacks exactly here.`,
        evidence: rg.raw.split("\n")[0],
        remediation: role === "client"
          ? `Add the far-end prefix via the spoke: sudo ip route add ${dstIp}/32 via <spoke-ip> dev <iface> ` +
            `(or set a default route).`
          : `Add a route on ${role} toward ${dstIp} via the next hop in the chain.`,
      }));
      continue;
    }
    if (rg.via) {
      const onLink = dataAddrs(node).some((a) => inSubnet(rg.via, a));
      if (!onLink) {
        out.push(finding({
          id: "l3.nexthop-offlink",
          layer: "L3",
          where: ROLE_LABEL[role],
          title: `Next hop ${rg.via} is not on a connected subnet of ${role}`,
          detail: `${role} wants to send traffic for ${dstIp} to ${rg.via}, but that address is outside every ` +
            `subnet configured on ${role}. The kernel cannot ARP for it, so the packets are dropped.`,
          evidence: `${rg.raw.split("\n")[0]} | local: ${dataAddrs(node).map((a) => a.cidr).join(", ")}`,
          remediation: `Point the route at a next hop inside one of ${role}'s subnets, or fix the interface's mask.`,
        }));
        continue;
      }
      const neigh = (node.neigh || []).find((n) => n.ip === rg.via);
      if (neigh && (neigh.state === "FAILED" || neigh.state === "INCOMPLETE") &&
          !l2Broken.has(`${role}->${topo.l3Chain[i + 1]}`)) {
        out.push(finding({
          id: "l2.nexthop-arp",
          layer: "L2",
          where: `${ROLE_LABEL[role]} -> ${rg.via}`,
          title: `Next hop ${rg.via} does not answer ARP`,
          detail: `The route on ${role} is correct but the gateway ${rg.via} never replies, so this is an L2 ` +
            `problem on that segment (portgroup / VLAN / link state), not a routing one.`,
          evidence: `ip neigh: ${rg.via} ${neigh.state} on ${neigh.dev}`,
          remediation: `Verify the gateway VM is up and its vNIC shares a portgroup+VLAN with ${role}'s ${rg.dev}.`,
        }));
      }
      const expectedNext = topo.l3Chain[i + 1];
      const owner = nodeOwningIp(facts, rg.via);
      if (owner && owner !== expectedNext) {
        out.push(finding({
          id: "l3.wrong-nexthop",
          layer: "L3",
          severity: "warning",
          where: ROLE_LABEL[role],
          title: `${role} routes ${dstIp} via ${owner}, not ${expectedNext}`,
          detail: `The chain under test is ${topo.l3Chain.join(" -> ")}, but ${role}'s route for ${dstIp} points ` +
            `at ${rg.via} which belongs to ${owner}. Traffic is bypassing the impairment path.`,
          evidence: rg.raw.split("\n")[0],
          remediation: `Repoint the route at ${expectedNext} (or remove the more specific route that wins).`,
        }));
      }
    }
  }

  /* return path */
  if (srcSubnet) {
    for (const role of [...topo.transit, topo.l3Chain[topo.l3Chain.length - 1]]) {
      const node = facts.nodes[role];
      if (!node || !node.reachable) continue;
      const rg = (routeGets[role] || {}).toSrc;
      if (rg && rg.unreachable) {
        out.push(finding({
          id: "l3.no-return-route",
          layer: "L3",
          where: ROLE_LABEL[role],
          title: `${role} has no route back to ${srcIp}`,
          detail: `Forward packets may arrive, but ${role} cannot answer: ip route get ${srcIp} fails. ` +
            `An asymmetric or missing return route looks exactly like a dead path from the client.`,
          evidence: rg.raw.split("\n")[0],
          remediation: `Add the return route on ${role}: sudo ip route add ${srcSubnet} via <previous-hop-ip>.`,
        }));
      }
    }
  }

  /* FORWARD chain drops on transit nodes */
  for (const role of topo.transit) {
    const node = facts.nodes[role];
    if (!node.reachable || !node.firewall) continue;
    const fw = node.firewall;
    const fwdDrops = fw.dropRules.filter((r) => /^-A\s+FORWARD/.test(r));
    if (fw.policies.FORWARD === "DROP" || fw.policies.FORWARD === "REJECT") {
      const accepts = /(^|\n)-A\s+FORWARD.*-j\s+ACCEPT/.test(fw.raw);
      out.push(finding({
        id: "l3.forward-policy-drop",
        layer: "L3",
        severity: accepts ? "warning" : "critical",
        where: ROLE_LABEL[role],
        title: `FORWARD policy on ${role} is ${fw.policies.FORWARD}`,
        detail: accepts
          ? `${role} defaults to ${fw.policies.FORWARD} in FORWARD with explicit ACCEPT rules — verify the test ` +
            `traffic actually matches one of them.`
          : `${role} must route the test traffic but its FORWARD policy is ${fw.policies.FORWARD} with no ACCEPT ` +
            `rule, so every forwarded packet is dropped by netfilter after routing succeeds.`,
        evidence: `iptables -P FORWARD ${fw.policies.FORWARD}${fwdDrops.length ? ` | ${fwdDrops.length} FORWARD drop rule(s)` : ""}`,
        remediation: `sudo iptables -P FORWARD ACCEPT (lab), or add an explicit rule for the test subnets.`,
      }));
    } else if (fwdDrops.length) {
      out.push(finding({
        id: "l3.forward-drop-rule",
        layer: "L3",
        severity: "warning",
        where: ROLE_LABEL[role],
        title: `${role} has ${fwdDrops.length} DROP/REJECT rule(s) in FORWARD`,
        detail: `Routing is configured, but netfilter may still discard the test flow on ${role}.`,
        evidence: fwdDrops.slice(0, 4).join("\n"),
        remediation: "Confirm the test subnets are not matched by those rules (iptables -L FORWARD -v -n).",
      }));
    }
  }

  /* rp_filter on transit nodes when the path is asymmetric */
  for (const role of topo.transit) {
    const node = facts.nodes[role];
    if (!node.reachable) continue;
    const rp = node.rpFilter || {};
    const strict = Object.entries(rp).filter(([, v]) => v === "1").map(([k]) => k);
    if (strict.length && (rp.all === "1" || strict.length > 1)) {
      out.push(finding({
        id: "l3.rp-filter",
        layer: "L3",
        severity: "warning",
        where: ROLE_LABEL[role],
        title: `Strict reverse-path filtering is on at ${role} (${strict.join(", ")})`,
        detail: `rp_filter=1 drops packets whose source would not be routed back out the interface they arrived ` +
          `on. With impairment paths that fail over between links this silently kills the flow after a switch.`,
        evidence: Object.entries(rp).map(([k, v]) => `${k}=${v}`).join(" "),
        remediation: `sudo sysctl -w net.ipv4.conf.all.rp_filter=2 (loose) while testing failover.`,
      }));
    }
  }

  /* traceroute: where does the path actually stop */
  if (e2e.traceroute && e2e.traceroute.hops && e2e.traceroute.hops.length) {
    const hops = e2e.traceroute.hops;
    const reached = hops.some((h) => h.ip === dstIp);
    const lastOk = [...hops].reverse().find((h) => h.ip);
    if (!reached) {
      const lastRole = lastOk ? nodeOwningIp(facts, lastOk.ip) : null;
      const idx = lastRole ? topo.l3Chain.indexOf(lastRole) : -1;
      const nextRole = idx >= 0 && idx < topo.l3Chain.length - 1 ? topo.l3Chain[idx + 1] : null;
      // an L2 fault already explains a truncated path — report it as evidence
      const corroborating = l2Broken.size > 0;
      out.push(finding({
        id: "l3.path-truncated",
        layer: corroborating ? "info" : "L3",
        severity: corroborating ? "info" : "critical",
        where: nextRole ? `${ROLE_LABEL[lastRole]} -> ${ROLE_LABEL[nextRole]}` : "path",
        title: corroborating
          ? `Traceroute confirms the path stops at the faulty segment (${[...l2Broken].join(", ")})`
          : lastOk
          ? `Traceroute stops after ${lastOk.ip}${lastRole ? ` (${lastRole})` : ""}`
          : "Traceroute gets no reply at all from the first hop",
        detail: corroborating
          ? `${dstIp} is never reached${lastOk ? `; the last hop to answer is ${lastOk.ip}` : ` and no hop answers`}, ` +
            `which is what the L2 fault above predicts. No separate routing problem is implied — fix the ` +
            `layer-2 finding and re-run before chasing routes.`
          : lastOk
          ? `The last hop that decremented TTL is ${lastOk.ip}${lastRole ? ` on ${lastRole}` : ""}; ${dstIp} is ` +
            `never reached. Routing lacks at ` +
            `${nextRole ? `${nextRole} (or on the ${lastRole} -> ${nextRole} segment)` : "the node after it"} — ` +
            `check its route toward ${dstIp} and its forwarding state.`
          : `Not even the first router answered, so the break is on the ${topo.l3Chain[0]} -> ` +
            `${topo.l3Chain[1] || "next hop"} segment.`,
        evidence: `${e2e.traceroute.via}: ` +
          hops.map((h) => `${h.ttl}:${h.ip || "*"}`).join(" "),
        remediation: corroborating
          ? "Nothing to do here — re-run once the layer-2 finding is fixed."
          : nextRole
          ? `On ${nextRole}: ip route get ${dstIp}; cat /proc/sys/net/ipv4/ip_forward; iptables -L FORWARD -v -n`
          : `Start at ${topo.l3Chain[0]}: ip route get ${dstIp} and ip neigh show.`,
      }));
    }
  }

  /* PMTU black hole: small pings pass, DF-large pings do not */
  const mtu = facts.probes.mtu;
  if (mtu && mtu.small && mtu.small.ok && mtu.large && !mtu.large.ok) {
    out.push(finding({
      id: "l3.pmtu-blackhole",
      layer: "L3",
      severity: "warning",
      where: "path",
      title: `Path MTU black hole: ${mtu.size}-byte packets with DF do not pass`,
      detail: `Small ICMP passes end to end but ${mtu.size}-byte DF packets are lost` +
        (mtu.large.frag ? " and the local stack reports fragmentation needed" : " with no ICMP too-big returned") +
        `. TCP will connect and then stall — a very common false "latency" report.`,
      evidence: `small: ${mtu.small.lossPct}% loss | ${mtu.size}B DF: ${mtu.large.lossPct}% loss`,
      remediation: "Align MTU across guest vNICs, vSwitches/portgroups and the netem bridge, or clamp MSS " +
        "on the transit node.",
    }));
  }

  return out;
}

/* ---------------------------------------------------------------- verdict */

const SEV_RANK = { critical: 0, warning: 1, info: 2 };

function analyze(facts, topo) {
  const fabric = buildL2Fabric(facts.esxi, facts.nodes);
  // L2 runs first and stamps seg.status, which the L3 pass reads to tell an
  // independent routing fault from a consequence of a broken segment
  const l2 = analyzeL2(facts, topo, fabric);
  const findings = [...l2, ...analyzeL3(facts, topo)];

  if (!facts.esxi || !facts.esxi.ok) {
    findings.push(finding({
      id: "info.no-esxi",
      layer: "info",
      severity: "info",
      where: "ESXi",
      title: "ESXi facts unavailable — L2 verdict rests on in-guest evidence only",
      detail: `Portgroup, VLAN and vNIC MAC data could not be read` +
        `${facts.esxi && facts.esxi.error ? ` (${facts.esxi.error})` : ""}, so portgroup and VLAN mismatches ` +
        `can only be inferred from ARP behaviour.`,
      evidence: (facts.esxi && facts.esxi.error) || "not collected",
      remediation: "Enable SSH on the host (Host > Actions > Services > Enable Secure Shell) and re-run.",
    }));
  }

  const chainPos = (where) => {
    const idx = ROLE_ORDER.findIndex((r) => String(where).toLowerCase().includes(r));
    return idx < 0 ? 99 : idx;
  };
  const layerRank = { access: 0, L2: 1, L3: 2, info: 3 };
  findings.sort((a, b) =>
    SEV_RANK[a.severity] - SEV_RANK[b.severity] ||
    layerRank[a.layer] - layerRank[b.layer] ||
    chainPos(a.where) - chainPos(b.where));

  const crit = findings.filter((f) => f.severity === "critical");
  const e2e = facts.probes.endToEnd || {};
  const e2eOk = !!(e2e.forward && e2e.forward.ok);

  // L2 first: portgroup / VLAN / MAC faults are read straight off the ESXi
  // configuration and hold even with a node down. ACCESS outranks L3 because
  // every L3 conclusion depends on probes that need the whole chain reachable.
  let verdict;
  if (crit.some((f) => f.layer === "L2")) verdict = "L2";
  else if (crit.some((f) => f.layer === "access")) verdict = "ACCESS";
  else if (crit.some((f) => f.layer === "L3")) verdict = "L3";
  else if (e2eOk) verdict = findings.some((f) => f.severity === "warning") ? "HEALTHY_WARN" : "HEALTHY";
  else verdict = "INCONCLUSIVE";

  const wantLayer = { L2: "L2", L3: "L3", ACCESS: "access" }[verdict];
  const primary = crit.find((f) => f.layer === wantLayer) || crit[0] || null;
  const summary = buildSummary(verdict, primary, facts, topo, e2e);

  return { verdict, summary, primary, findings, segments: topo.segments, topo, fabric: fabric.merges, e2eOk };
}

function buildSummary(verdict, primary, facts, topo, e2e) {
  const path = topo.present.map((r) => ROLE_LABEL[r]).join(" -> ");
  const t = topo.target;
  const head = {
    L2: "Layer 2 issue",
    L3: "Layer 3 issue",
    ACCESS: "Cannot reach part of the testbed",
    HEALTHY: "No fault found",
    HEALTHY_WARN: "Path works, with warnings",
    INCONCLUSIVE: "Path is down but no single cause proved",
  }[verdict];
  const lines = [`${head} — ${path}`];
  if (t.srcIp && t.dstIp) {
    lines.push(`Test flow ${t.srcIp} -> ${t.dstIp}: ` +
      (e2e.forward ? `${e2e.forward.lossPct}% loss` +
        (e2e.forward.rttAvgMs ? `, ${e2e.forward.rttAvgMs} ms avg` : "") : "not probed"));
  }
  if (primary) lines.push(`${primary.where}: ${primary.title}`);
  if (verdict === "INCONCLUSIVE") {
    lines.push("Every segment resolved ARP and every hop has a route, yet the flow does not complete — " +
      "look at application-level filtering, NAT, or an impairment profile that is dropping everything.");
  }
  return lines.join("\n");
}

module.exports = {
  ROLE_ORDER,
  ROLE_LABEL,
  buildTopology,
  buildL2Fabric,
  attachEsxiPorts,
  classifyNode,
  pickAddrPair,
  analyze,
  analyzeL2,
  analyzeL3,
  arpResolved,
  dataAddrs,
};
