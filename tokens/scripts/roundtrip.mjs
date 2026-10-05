#!/usr/bin/env node
// Round-trip check: computes the same per-collection/mode hashes as scripts/figma/roundtrip-hash.js,
// but from the token files. Paste the Figma script's JSON result into a file and pass its path:
//   node scripts/roundtrip.mjs figma-result.json
// Without an argument it just prints the token-side hashes.
import fs from 'node:fs';
import path from 'node:path';
import { loadTokens, resolve, normalizeColor, dimensionToPx, PACKAGE_ROOT } from '../lib/index.mjs';

const { tokens } = loadTokens();
const config = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'collections.json'), 'utf8')).collections;

const canonical = (t, value) => {
  if (t.type === 'color') return normalizeColor(value);
  if (t.type === 'dimension') return String(Number(dimensionToPx(value).toFixed(4)));
  return String(value);
};
const fnv = s => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
};

const ours = {};
const linesByKey = {};
for (const c of config) {
  for (const m of c.modes) {
    const lines = [];
    for (const t of tokens.values()) {
      if (t.collection !== c.slug) continue;
      // Own collection in this mode; every other collection in its default mode (Figma semantics).
      const { value } = resolve(tokens, t.path, { [c.slug]: m.slug });
      lines.push(`${t.path.split('.').join('/')}\t${canonical(t, value)}`);
    }
    lines.sort();
    const key = `${c.name}/${m.name}`;
    linesByKey[key] = lines;
    ours[key] = { count: lines.length, hash: fnv(lines.join('\n')) };
  }
}

// Effect + text styles from the raw snapshot (the source of extended/shadow.json and heading line heights).
const styles = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'figma-snapshot/raw/styles.json'), 'utf8'));
const r4 = n => String(Number(Number(n).toFixed(4)));
const effectLines = styles.effects
  .map(s => [s.name, ...s.effects.map(e => [e.type, e.visible, e.color ?? '', r4(e.x ?? 0), r4(e.y ?? 0), r4(e.blur ?? 0), r4(e.spread ?? 0)].join(','))].join('|'))
  .sort();
const textLines = styles.texts
  .map(s => [s.name, s.family, s.style, r4(s.size), s.lineHeight === 'AUTO' ? 'AUTO' : r4(s.lineHeight.value), r4(s.letterSpacing?.value ?? 0), s.decoration].join('|'))
  .sort();
ours['Effect styles'] = { count: effectLines.length, hash: fnv(effectLines.join('\n')) };
ours['Text styles'] = { count: textLines.length, hash: fnv(textLines.join('\n')) };

const file = process.argv[2];
if (!file) {
  console.log(JSON.stringify(ours, null, 2));
  process.exit(0);
}
const figma = JSON.parse(fs.readFileSync(file, 'utf8'));
let bad = 0;
for (const key of new Set([...Object.keys(ours), ...Object.keys(figma)])) {
  const a = ours[key], b = figma[key];
  const ok = a && b && a.count === b.count && a.hash === b.hash;
  if (!ok) bad++;
  console.log(`${ok ? '✓' : '✗'} ${key.padEnd(32)} tokens ${a ? `${a.count} ${a.hash}` : '—'}   figma ${b ? `${b.count} ${b.hash}` : '—'}`);
  if (!ok && b?.lines) {
    const mine = new Set(linesByKey[key]);
    for (const l of b.lines) if (!mine.has(l)) console.log(`    figma only: ${l}`);
    for (const l of linesByKey[key] ?? []) if (!b.lines.includes(l)) console.log(`    tokens only: ${l}`);
  }
}
if (bad) process.exit(1);
console.log(`Round trip OK: ${Object.keys(ours).length} collection/mode pairs identical.`);
