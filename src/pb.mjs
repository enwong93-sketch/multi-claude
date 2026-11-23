// Minimal schema-less protobuf codec (enough to clone and edit Antigravity step records).
// Nodes: { f: fieldNumber, w: wireType, v: bigint | Buffer, kids?: Node[] }. A length-delimited field is decoded into `kids`
// only when it is not plain text and re-encodes byte for byte, so untouched data always round-trips unchanged.

function rdVarint(b, p) { let r = 0n, s = 0n; for (;;) { if (p >= b.length) throw new Error('eof'); const c = b[p++]; r |= BigInt(c & 127) << s; if (!(c & 128)) break; s += 7n; if (s > 70n) throw new Error('varint'); } return [r, p]; }
function wrVarint(n) { n = BigInt(n); const o = []; do { let c = Number(n & 127n); n >>= 7n; if (n) c |= 128; o.push(c); } while (n); return Buffer.from(o); }

export function parseFlat(b) {
  const out = []; let p = 0;
  while (p < b.length) {
    let tag; [tag, p] = rdVarint(b, p); const f = Number(tag >> 3n), w = Number(tag & 7n);
    if (f === 0) throw new Error('field 0');
    if (w === 0) { let v; [v, p] = rdVarint(b, p); out.push({ f, w, v }); }
    else if (w === 1) { if (p + 8 > b.length) throw new Error('eof'); out.push({ f, w, v: Buffer.from(b.subarray(p, p + 8)) }); p += 8; }
    else if (w === 5) { if (p + 4 > b.length) throw new Error('eof'); out.push({ f, w, v: Buffer.from(b.subarray(p, p + 4)) }); p += 4; }
    else if (w === 2) { let l; [l, p] = rdVarint(b, p); l = Number(l); if (p + l > b.length) throw new Error('eof'); out.push({ f, w, v: Buffer.from(b.subarray(p, p + l)) }); p += l; }
    else throw new Error('wire ' + w);
  }
  return out;
}

const TEXT = /^[\t\n\r\x20-\x7e -￿]+$/;
const looksText = buf => { const s = buf.toString('utf8'); return buf.length > 0 && !s.includes('�') && TEXT.test(s); };

export function encode(nodes) {
  const parts = [];
  for (const n of nodes) {
    parts.push(wrVarint((BigInt(n.f) << 3n) | BigInt(n.w)));
    if (n.w === 0) parts.push(wrVarint(n.v));
    else if (n.w === 2) { const body = n.kids ? encode(n.kids) : n.v; parts.push(wrVarint(body.length), body); }
    else parts.push(n.v);
  }
  return Buffer.concat(parts);
}

export function decode(buf, depth = 0) {
  const nodes = parseFlat(buf);
  if (depth < 12) for (const n of nodes) {
    if (n.w !== 2 || n.v.length === 0) continue;
    // Try "embedded message" first: text such as "\n(Compute..." is also valid text, but a clean full parse that re-encodes
    // identically is far more likely a message. Plain prose almost never survives this test.
    try { const kids = decode(n.v, depth + 1); if (kids.length && encode(kids).equals(n.v)) n.kids = kids; } catch { /* text or opaque bytes */ }
  }
  return nodes;
}

/** First node matching a field path, e.g. find(tree, [19, 3, 1]). */
export function find(nodes, path) {
  let cur = nodes, node = null;
  for (const f of path) { node = (cur || []).find(n => n.f === f) || null; if (!node) return null; cur = node.kids; }
  return node;
}
const str = s => Buffer.from(String(s), 'utf8');
export function setText(nodes, path, text) { const n = find(nodes, path); if (!n) return false; n.v = str(text); delete n.kids; return true; }
export function setVarint(nodes, path, v) { const n = find(nodes, path); if (!n) return false; n.v = BigInt(v); return true; }
export function removeField(nodes, path) {
  const parent = path.length > 1 ? find(nodes, path.slice(0, -1)) : null; const list = path.length > 1 ? parent?.kids : nodes;
  if (!list) return false; const i = list.findIndex(n => n.f === path[path.length - 1]); if (i < 0) return false; list.splice(i, 1); return true;
}

/** Visit every leaf (varint or bytes without kids); fn may return a replacement (string/Buffer for bytes, bigint for varint). */
export function mapLeaves(nodes, fn) {
  for (const n of nodes) {
    if (n.kids) {
      // A text value (an id, a path) can accidentally parse as a message: offer the whole value as a leaf first.
      const whole = encode(n.kids);
      if (looksText(whole)) { const r = fn({ f: n.f, w: 2, v: whole }); if (r !== undefined) { n.v = Buffer.isBuffer(r) ? r : str(r); delete n.kids; continue; } }
      mapLeaves(n.kids, fn); continue;
    }
    const r = fn(n);
    if (r === undefined) continue;
    if (n.w === 0) n.v = BigInt(r); else if (n.w === 2) n.v = Buffer.isBuffer(r) ? r : str(r);
  }
}
/** Replace a substring inside every text leaf. */
export function replaceText(nodes, from, to) {
  mapLeaves(nodes, n => { if (n.w !== 2) return; const s = n.v.toString('utf8'); return s.includes(from) ? s.split(from).join(to) : undefined; });
}

/** Timestamps are messages shaped { 1: seconds, 2: nanos }; shift every one of them by deltaSec. */
export function shiftTimestamps(nodes, deltaSec) {
  for (const n of nodes) {
    if (!n.kids) continue;
    const k = n.kids;
    if (k.length === 2 && k[0].f === 1 && k[1].f === 2 && k[0].w === 0 && k[1].w === 0 && k[0].v > 1500000000n && k[0].v < 2500000000n) k[0].v += BigInt(deltaSec);
    else shiftTimestamps(k, deltaSec);
  }
}
export function setTimestamp(nodes, path, sec, nanos = 0) {
  const n = find(nodes, path); if (!n?.kids) return false; n.kids[0].v = BigInt(sec); if (n.kids[1]) n.kids[1].v = BigInt(nanos); return true;
}
