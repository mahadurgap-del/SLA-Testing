/** IPv4 maths shared by the collectors and the decision engine. */

"use strict";

function ipToInt(ip) {
  const p = String(ip ?? "").trim().split(".");
  if (p.length !== 4) return null;
  let n = 0;
  for (const o of p) {
    if (!/^\d{1,3}$/.test(o) || Number(o) > 255) return null;
    n = n * 256 + Number(o);
  }
  return n >>> 0;
}

function intToIp(n) {
  return [24, 16, 8, 0].map((s) => (n >>> s) & 255).join(".");
}

function maskInt(prefix) {
  const p = Number(prefix);
  if (!Number.isInteger(p) || p < 0 || p > 32) return null;
  return p === 0 ? 0 : (0xffffffff << (32 - p)) >>> 0;
}

/** Network address of ip/prefix, or null when either is unusable. */
function networkOf(ip, prefix) {
  const i = ipToInt(ip);
  const m = maskInt(prefix);
  if (i === null || m === null) return null;
  return (i & m) >>> 0;
}

function cidrOf(ip, prefix) {
  const n = networkOf(ip, prefix);
  return n === null ? null : `${intToIp(n)}/${prefix}`;
}

/** True when both addresses sit in one another's subnet (i.e. are L3 adjacent). */
function sameSubnet(a, b) {
  if (!a || !b) return false;
  const na = networkOf(a.ip, a.prefix);
  const nb = networkOf(b.ip, b.prefix);
  if (na === null || nb === null) return false;
  // matching prefixes is the common case; tolerate a /24 vs /25 style mismatch
  // by requiring that each address falls inside the other's subnet
  const aInB = networkOf(a.ip, b.prefix) === nb;
  const bInA = networkOf(b.ip, a.prefix) === na;
  return aInB && bInA;
}

/** True when ip falls inside the network of ref (ip/prefix). */
function inSubnet(ip, ref) {
  if (!ref) return false;
  const n = networkOf(ref.ip, ref.prefix);
  return n !== null && networkOf(ip, ref.prefix) === n;
}

function isPrivateOrUsable(ip) {
  const n = ipToInt(ip);
  if (n === null) return false;
  const first = (n >>> 24) & 255;
  return first !== 0 && first !== 127 && first < 224;
}

module.exports = { ipToInt, intToIp, maskInt, networkOf, cidrOf, sameSubnet, inSubnet, isPrivateOrUsable };
