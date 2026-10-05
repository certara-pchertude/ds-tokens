#!/usr/bin/env node
// Converts the raw Figma extraction in figma-snapshot/raw/ into:
//   figma-snapshot/variables.json  — assembled, normalized snapshot (all collections)
//   src/<collection>/<mode>/<collection>.json — W3C DTCG token files mirroring Figma 1:1
//
// Idempotent: src/ is regenerated from the snapshot on every run.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { slug, decodeEntities, FIGMA_EXT } from '../lib/index.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rawDir = path.join(root, 'figma-snapshot/raw');
const srcDir = path.join(root, 'src');

// Aliases to variables outside this file (Figma reports them by remote id). Each one is
// re-pointed at the local variable with the same name and listed in the discrepancy report.
const EXTERNAL_ALIAS_TARGETS = {
  'VariableID:4cbba4ee0431dc99a284bee454f2903bf28de8c7/15657:223': 'space/unit/75',
};

const meta = JSON.parse(fs.readFileSync(path.join(rawDir, '_meta.json'), 'utf8'));
const chunks = fs
  .readdirSync(rawDir)
  .filter(f => f.endsWith('.json') && !f.startsWith('_') && f !== 'styles.json')
  .flatMap(f => [].concat(JSON.parse(fs.readFileSync(path.join(rawDir, f), 'utf8'))));

const collections = meta.collections.map(c => {
  const parts = chunks.filter(ch => ch.collection === c.name).sort((a, b) => a.from - b.from);
  const items = parts.flatMap(p => p.items);
  if (items.length !== c.count) {
    throw new Error(`${c.name}: expected ${c.count} variables, snapshot has ${items.length}`);
  }
  const commonScopes = c.scopes ? c.scopes.split(',') : [];
  return {
    ...c,
    variables: items.map(([id, name, type, values, scopes, description, codeSyntax]) => ({
      id: `VariableID:${id}`,
      name,
      type: { C: 'COLOR', F: 'FLOAT', S: 'STRING', B: 'BOOLEAN' }[type],
      valuesByMode: Object.fromEntries(c.modes.map((m, i) => [m, values[i]])),
      scopes: scopes ?? commonScopes,
      description: description ? decodeEntities(description) : null,
      codeSyntax,
    })),
  };
});

const total = collections.reduce((n, c) => n + c.variables.length, 0);
if (total !== meta.total) throw new Error(`Expected ${meta.total} variables, assembled ${total}`);

fs.writeFileSync(
  path.join(root, 'figma-snapshot/variables.json'),
  JSON.stringify({ source: { fileKey: meta.fileKey, mainFileKey: meta.mainFileKey, fileName: meta.fileName, extractedAt: meta.extractedAt }, total, collections }, null, 2) + '\n',
);

// ---- DTCG emission ----------------------------------------------------------------------------
const toDtcgType = v => {
  if (v.type === 'COLOR') return 'color';
  if (v.type === 'FLOAT') return 'dimension';
  if (v.type === 'BOOLEAN') return 'boolean';
  if (v.scopes.includes('FONT_FAMILY')) return 'fontFamily';
  return 'string';
};

const toDtcgValue = (v, raw) => {
  if (raw && typeof raw === 'object') {
    const target = raw.alias ?? EXTERNAL_ALIAS_TARGETS[raw.ext];
    if (!target) throw new Error(`${v.name}: unresolvable alias ${raw.ext}`);
    return `{${target.split('/').join('.')}}`;
  }
  if (v.type === 'FLOAT') return { value: raw, unit: 'px' }; // DTCG 2025.10 dimension object
  return raw;
};

const setPath = (obj, segments, leaf, varName) => {
  let node = obj;
  for (const seg of segments.slice(0, -1)) {
    node[seg] ??= {};
    if ('$value' in node[seg]) throw new Error(`${varName}: "${seg}" is both a token and a group`);
    node = node[seg];
  }
  const last = segments.at(-1);
  if (node[last]) throw new Error(`${varName}: duplicate or group/token clash`);
  node[last] = leaf;
};

// Collection/mode metadata lives outside src/ so Token Nexus doesn't mistake it for tokens.
fs.writeFileSync(
  path.join(root, 'collections.json'),
  JSON.stringify(
    {
      $description: 'Figma variable collections mirrored in src/<collection>/<mode>/. Modes are listed in Figma order; defaultMode is Figma\'s default.',
      collections: collections.map(c => ({
        slug: slug(c.name),
        name: c.name,
        figmaId: c.id,
        hiddenFromPublishing: c.hidden,
        modes: c.modes.map(m => ({ slug: slug(m), name: m })),
        defaultMode: slug(c.defaultMode),
      })),
    },
    null,
    2,
  ) + '\n',
);

fs.rmSync(srcDir, { recursive: true, force: true });
let written = 0;
for (const c of collections) {
  for (const mode of c.modes) {
    const doc = {};
    for (const v of c.variables) {
      const raw = v.valuesByMode[mode];
      const ext = { variableId: v.id, collection: c.name, scopes: v.scopes };
      if (c.hidden) ext.hiddenFromPublishing = true;
      if (v.codeSyntax) ext.codeSyntax = v.codeSyntax;
      if (raw && typeof raw === 'object' && raw.ext) ext.externalAlias = raw.ext;
      const leaf = { $type: toDtcgType(v), $value: toDtcgValue(v, raw) };
      if (v.description) leaf.$description = v.description;
      leaf.$extensions = { [FIGMA_EXT]: ext };
      setPath(doc, v.name.split('/'), leaf, v.name);
      written++;
    }
    const dir = path.join(srcDir, slug(c.name), slug(mode));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${slug(c.name)}.json`), JSON.stringify(doc, null, 2) + '\n');
  }
}
console.log(`Imported ${total} Figma variables from ${collections.length} collections (${written} token-mode entries).`);

// ---- Effect styles → extended/shadow.json ---------------------------------------------------------
// Figma effect styles aren't variables (Token Nexus can't sync them), so they live in extended/.
// Token key = style path with "/" → nesting, joined into a single key below the first group so a
// style like "Shadow/100/Brand" doesn't clash with "Shadow/100": shadow."100 brand" → --shadow-100-brand.
const styles = JSON.parse(fs.readFileSync(path.join(rawDir, 'styles.json'), 'utf8'));

// Values certara-ui has that Figma doesn't model (no dark-mode effect styles, no button shadow style).
const CODE_ONLY_SHADOWS = {
  shadow: {
    '100': {
      dark: [{ color: '#ffffff33', offsetX: '0px', offsetY: '0px', blur: '0px', spread: '1px' }],
    },
  },
  'btn-box-shadow': {
    $type: 'shadow',
    $value: [
      { color: '#86868666', offsetX: '0px', offsetY: '2px', blur: '4px', spread: '0px' },
      { color: '#00000033', offsetX: '0px', offsetY: '1px', blur: '2px', spread: '0px' },
    ],
    $description: 'Code-only: no matching Figma effect style.',
    $extensions: {
      'com.certara': {
        dark: [
          { color: '#00000038', offsetX: '0px', offsetY: '2px', blur: '4px', spread: '0px' },
          { color: '#00000033', offsetX: '0px', offsetY: '1px', blur: '2px', spread: '0px' },
        ],
      },
    },
  },
};

const shadowDoc = {
  $description:
    'Generated from Figma effect styles by scripts/import-figma.mjs — edit Figma and re-import, or edit here and update Figma by hand (effect styles are not variables, so Token Nexus cannot sync them).',
};
for (const s of styles.effects) {
  const [group, ...rest] = s.name.split('/');
  const groupKey = slug(group);
  const key = rest.join(' ').toLowerCase();
  const leaf = {
    $type: 'shadow',
    $value: s.effects
      .filter(e => e.visible)
      .map(e => ({
        color: e.color,
        offsetX: `${e.x}px`,
        offsetY: `${e.y}px`,
        blur: `${e.blur}px`,
        spread: `${e.spread}px`,
        ...(e.type === 'INNER_SHADOW' ? { inset: true } : {}),
      })),
  };
  if (s.description) leaf.$description = decodeEntities(s.description);
  const extra = CODE_ONLY_SHADOWS[groupKey]?.[key];
  leaf.$extensions = { [FIGMA_EXT]: { effectStyle: s.name }, ...(extra?.dark ? { 'com.certara': { dark: extra.dark } } : {}) };
  shadowDoc[groupKey] ??= {};
  shadowDoc[groupKey][key] = leaf;
}
shadowDoc['btn-box-shadow'] = CODE_ONLY_SHADOWS['btn-box-shadow'];
fs.writeFileSync(path.join(root, 'extended/shadow.json'), JSON.stringify(shadowDoc, null, 2) + '\n');
console.log(`Wrote ${styles.effects.length} effect styles to extended/shadow.json.`);
