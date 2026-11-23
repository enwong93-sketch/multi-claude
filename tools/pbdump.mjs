// Schema-less protobuf dumper (research helper). Usage: node pbdump.mjs <hexfile|-> ; or import dump().
export function readVarint(b, p) { let r = 0n, s = 0n; for (;;) { const c = b[p++]; r |= BigInt(c & 127) << s; if (!(c & 128)) break; s += 7n; } return [r, p]; }
export function parse(b) {
  const out = []; let p = 0;
  while (p < b.length) {
    let tag; [tag, p] = readVarint(b, p); const f = Number(tag >> 3n), w = Number(tag & 7n);
    if (w === 0) { let v; [v, p] = readVarint(b, p); out.push({ f, w, v }); }
    else if (w === 1) { out.push({ f, w, v: b.subarray(p, p + 8) }); p += 8; }
    else if (w === 5) { out.push({ f, w, v: b.subarray(p, p + 4) }); p += 4; }
    else if (w === 2) { let l; [l, p] = readVarint(b, p); l = Number(l); out.push({ f, w, v: b.subarray(p, p + l) }); p += l; }
    else throw new Error('bad wire ' + w);
  }
  return out;
}
export function dump(b, ind = '', depth = 0) {
  let fs; try { fs = parse(b); } catch { return ind + '(unparseable)\n'; }
  let s = '';
  for (const x of fs) {
    if (x.w === 2) {
      const t = Buffer.from(x.v).toString('utf8');
      const printable = x.v.length && /^[\x09\x0a\x0d\x20-\x7e\u00a0-\uffff]+$/.test(t) && !t.includes('\ufffd');
      let sub = null; if (!printable || x.v.length < 4) { try { const q = parse(x.v); if (q.length && depth < 8) sub = q; } catch {} }
      if (printable && x.v.length >= 2) s += `${ind}${x.f}: "${t.length > 300 ? t.slice(0, 300) + '…(' + t.length + ')' : t}"\n`;
      else if (sub) s += `${ind}${x.f}: {\n${dump(x.v, ind + '  ', depth + 1)}${ind}}\n`;
      else s += `${ind}${x.f}: <${x.v.length}b>\n`;
    } else s += `${ind}${x.f}: ${x.w === 0 ? x.v : Buffer.from(x.v).toString('hex')}\n`;
  }
  return s;
}
