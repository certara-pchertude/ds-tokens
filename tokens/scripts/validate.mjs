#!/usr/bin/env node
// Structural checks for the token source. Exits non-zero on any failure.
//  1. src/ mirrors the Figma snapshot 1:1 (same variables, same per-mode values, same ids)
//  2. every mode folder of a collection defines the same tokens with the same $type
//  3. every alias resolves, without cycles, in every combination of modes
//  4. DTCG naming rules, and no two tokens map to the same CSS custom property
//  5. rename-map.json: old names aren't tokens; new names are
import fs from 'node:fs';
import path from 'node:path';
import { loadTokens, loadRenameMap, resolve, cssName, aliasTarget, PACKAGE_ROOT } from '../lib/index.mjs';

const failures = [];
const fail = msg => failures.push(msg);
const { tokens, collections } = loadTokens();
const snapshot = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'figma-snapshot/variables.json'), 'utf8'));

// 1. Figma round trip (offline, against the committed snapshot).
const figmaTokens = [...tokens.values()].filter(t => t.source === 'figma');
if (figmaTokens.length !== snapshot.total) fail(`src/ has ${figmaTokens.length} tokens, snapshot has ${snapshot.total}`);
const byId = new Map(figmaTokens.map(t => [t.figma.variableId, t]));
if (byId.size !== figmaTokens.length) fail('duplicate Figma variable ids in src/');
const slugOf = s => s.trim().toLowerCase().replace(/\s+/g, '-');
const EXTERNAL = { 'VariableID:4cbba4ee0431dc99a284bee454f2903bf28de8c7/15657:223': 'space/unit/75' };
let compared = 0;
for (const c of snapshot.collections) {
  for (const v of c.variables) {
    const t = byId.get(v.id);
    if (!t) {
      fail(`Figma variable ${v.name} (${v.id}) missing from src/`);
      continue;
    }
    if (t.path !== v.name.split('/').join('.')) fail(`${v.id}: path ${t.path} ≠ Figma name ${v.name}`);
    for (const [mode, raw] of Object.entries(v.valuesByMode)) {
      const expected =
        raw && typeof raw === 'object' ? `{${(raw.alias ?? EXTERNAL[raw.ext]).split('/').join('.')}}` : v.type === 'FLOAT' ? { value: raw, unit: 'px' } : raw;
      const actual = t.values[slugOf(mode)];
      if (JSON.stringify(actual) !== JSON.stringify(expected)) fail(`${v.name} [${mode}]: token ${JSON.stringify(actual)} ≠ Figma ${JSON.stringify(expected)}`);
      compared++;
    }
  }
}

// 2. Mode folders agree.
for (const c of collections.filter(c => c.slug !== 'extended')) {
  for (const t of tokens.values()) {
    if (t.collection !== c.slug) continue;
    const missing = c.modes.filter(m => !(m in t.values));
    if (missing.length) fail(`${t.path}: missing in mode(s) ${missing.join(', ')}`);
  }
}

// 3. Aliases resolve in every mode combination.
const multi = collections.filter(c => c.modes.length > 1 && c.slug !== 'extended');
let contexts = [{}];
for (const c of multi) contexts = contexts.flatMap(ctx => c.modes.map(m => ({ ...ctx, [c.slug]: m })));
contexts = contexts.flatMap(ctx => [{ ...ctx, extended: 'base' }, { ...ctx, extended: 'dark' }]);
let resolutions = 0;
for (const ctx of contexts) {
  for (const t of tokens.values()) {
    try {
      resolve(tokens, t.path, ctx);
      resolutions++;
    } catch (e) {
      fail(`${t.path} in ${JSON.stringify(ctx)}: ${e.message}`);
    }
  }
}
for (const t of tokens.values()) {
  for (const v of Object.values(t.values)) {
    const target = tokens.get(aliasTarget(v));
    if (target && target.type !== t.type) fail(`${t.path} ($type ${t.type}) aliases ${target.path} ($type ${target.type})`);
  }
}

// 4. Naming.
const cssNames = new Map();
for (const t of tokens.values()) {
  for (const seg of t.path.split('.')) {
    if (!seg || /[{}]/.test(seg) || seg.startsWith('$')) fail(`${t.path}: invalid DTCG name segment "${seg}"`);
  }
  const n = cssName(t.path);
  if (cssNames.has(n)) fail(`CSS name collision ${n}: ${cssNames.get(n)} and ${t.path}`);
  cssNames.set(n, t.path);
}

// 5. Rename map.
const { renames } = loadRenameMap();
for (const [o, n] of Object.entries(renames)) {
  if (cssNames.has(o)) fail(`rename-map: old name ${o} is also a token (${cssNames.get(o)})`);
  if (!cssNames.has(n)) fail(`rename-map: ${o} → ${n}, but ${n} is not a token`);
}

const extended = tokens.size - figmaTokens.length;
if (failures.length) {
  console.error(`✗ ${failures.length} problem(s):\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log(`✓ ${figmaTokens.length} Figma tokens match the snapshot (${compared} mode values), ${extended} extended tokens.`);
console.log(`✓ ${resolutions} alias resolutions across ${contexts.length} mode combinations; ${cssNames.size} unique CSS names; ${Object.keys(renames).length} renames valid.`);
