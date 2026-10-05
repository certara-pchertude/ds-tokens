// Shared helpers for reading DTCG token files and resolving them per mode.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIGMA_EXT = 'com.figma';
export const CERTARA_EXT = 'com.certara';
export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const slug = s => s.trim().toLowerCase().replace(/\s+/g, '-');

export const decodeEntities = s =>
  s.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');

/** Token path (dot- or slash-separated, spaces allowed) → CSS custom property name. */
export const cssName = tokenPath => '--' + tokenPath.split(/[./]/).map(slug).join('-');

const ALIAS_RE = /^\{([^{}]+)\}$/;
export const aliasTarget = value => (typeof value === 'string' ? value.match(ALIAS_RE)?.[1] ?? null : null);

const walk = (node, trail, out) => {
  for (const [key, child] of Object.entries(node)) {
    if (key.startsWith('$')) continue;
    if (child && typeof child === 'object' && '$value' in child) out.push([[...trail, key].join('.'), child]);
    else if (child && typeof child === 'object') walk(child, [...trail, key], out);
  }
  return out;
};

const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));

/**
 * Loads every token set:
 *  - src/<collection>/<mode>/*.json  (Figma-mirrored; one folder per mode)
 *  - extended/*.json                (code-only / non-variable tokens; single "base" mode with an
 *                                    optional dark override in $extensions["com.certara"].dark)
 * Returns { collections, tokens } where tokens maps path → token record.
 */
export function loadTokens(root = PACKAGE_ROOT) {
  const tokens = new Map();
  const collections = [];
  const srcDir = path.join(root, 'src');
  const config = readJson(path.join(root, 'collections.json')).collections;
  for (const colSlug of fs.readdirSync(srcDir).sort()) {
    const colDir = path.join(srcDir, colSlug);
    if (!fs.statSync(colDir).isDirectory()) continue;
    const onDisk = fs.readdirSync(colDir).filter(m => fs.statSync(path.join(colDir, m)).isDirectory());
    const cfg = config.find(c => c.slug === colSlug);
    if (!cfg) throw new Error(`src/${colSlug} is not listed in collections.json`);
    // Default mode first, then Figma order.
    const modes = [cfg.defaultMode, ...cfg.modes.map(m => m.slug).filter(m => m !== cfg.defaultMode)];
    const stray = onDisk.filter(m => !modes.includes(m));
    if (stray.length || onDisk.length !== modes.length) throw new Error(`src/${colSlug}: mode folders ${onDisk} ≠ collections.json ${modes}`);
    let collectionName = cfg.name;
    for (const mode of modes) {
      for (const file of fs.readdirSync(path.join(colDir, mode)).filter(f => f.endsWith('.json'))) {
        for (const [p, leaf] of walk(readJson(path.join(colDir, mode, file)), [], [])) {
          const figma = leaf.$extensions?.[FIGMA_EXT] ?? {};
          collectionName = figma.collection ?? collectionName;
          const rec = tokens.get(p) ?? {
            path: p,
            type: leaf.$type,
            description: leaf.$description ?? null,
            figma,
            collection: colSlug,
            source: 'figma',
            values: {},
          };
          if (rec.collection !== colSlug) throw new Error(`Token ${p} defined in two collections`);
          rec.values[mode] = leaf.$value;
          tokens.set(p, rec);
        }
      }
    }
    collections.push({ slug: colSlug, name: collectionName, modes, hidden: false });
  }
  for (const c of collections) {
    const sample = [...tokens.values()].find(t => t.collection === c.slug);
    c.hidden = Boolean(sample?.figma.hiddenFromPublishing);
  }

  const extDir = path.join(root, 'extended');
  if (fs.existsSync(extDir)) {
    const modes = ['base'];
    for (const file of fs.readdirSync(extDir).filter(f => f.endsWith('.json')).sort()) {
      for (const [p, leaf] of walk(readJson(path.join(extDir, file)), [], [])) {
        if (tokens.has(p)) throw new Error(`extended/${file}: ${p} already defined`);
        const certara = leaf.$extensions?.[CERTARA_EXT] ?? {};
        const values = { base: leaf.$value };
        if (certara.dark !== undefined) values.dark = certara.dark;
        tokens.set(p, {
          path: p,
          type: leaf.$type,
          description: leaf.$description ?? null,
          certara,
          collection: 'extended',
          file,
          source: 'extended',
          values,
        });
      }
    }
    collections.push({ slug: 'extended', name: 'Extended (code-only)', modes, hidden: false });
  }
  return { collections, tokens };
}

/**
 * Resolves a token's value for a mode context ({ [collectionSlug]: mode }). Aliases follow the
 * target collection's mode from the context (falling back to its first/only mode), like Figma does.
 * Returns { value, chain } where chain lists every alias hop.
 */
export function resolve(tokens, p, context, chain = []) {
  const t = tokens.get(p);
  if (!t) throw new Error(`Unknown token ${p}${chain.length ? ` (via ${chain.join(' → ')})` : ''}`);
  if (chain.includes(p)) throw new Error(`Alias cycle: ${[...chain, p].join(' → ')}`);
  const mode = pickMode(t, context);
  const raw = t.values[mode];
  const target = aliasTarget(raw);
  if (target) return resolve(tokens, target, context, [...chain, p]);
  if (Array.isArray(raw) || (raw && typeof raw === 'object')) {
    return { value: resolveDeep(tokens, raw, context, [...chain, p]), chain: [...chain, p], token: t };
  }
  return { value: raw, chain: [...chain, p], token: t };
}

const resolveDeep = (tokens, v, context, chain) => {
  if (Array.isArray(v)) return v.map(x => resolveDeep(tokens, x, context, chain));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolveDeep(tokens, x, context, chain)]));
  const target = aliasTarget(v);
  return target ? resolve(tokens, target, context, chain).value : v;
};

export function pickMode(t, context) {
  const want = context[t.collection];
  if (want && want in t.values) return want;
  if (t.collection === 'extended') return context.extended === 'dark' && 'dark' in t.values ? 'dark' : 'base';
  return Object.keys(t.values)[0];
}

/** DTCG dimension ({ value, unit } object, or a legacy "8px" string) → px number. */
export function dimensionToPx(v) {
  if (v && typeof v === 'object' && 'value' in v) return v.unit === 'rem' ? v.value * 16 : v.value;
  const m = String(v).match(/^(-?[\d.]+)(px|rem)?$/);
  return m ? (m[2] === 'rem' ? parseFloat(m[1]) * 16 : parseFloat(m[1])) : null;
}

/** Normalizes a color string (#rgb, #rrggbb, #rrggbbaa, rgb()/rgba()) to lowercase #rrggbb[aa]. */
export function normalizeColor(input) {
  if (typeof input !== 'string') return null;
  const s = input.trim().toLowerCase();
  let m = s.match(/^#([0-9a-f]{3,8})$/);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = [...h].map(c => c + c).join('');
    if (h.length === 8 && h.endsWith('ff')) h = h.slice(0, 6);
    return '#' + h;
  }
  m = s.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*(?:[,/]\s*([\d.]+%?))?\s*\)$/);
  if (m) {
    const hx = n => Math.round(Number(n)).toString(16).padStart(2, '0');
    let a = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    const alpha = a >= 1 ? '' : hx(a * 255);
    return '#' + hx(m[1]) + hx(m[2]) + hx(m[3]) + alpha;
  }
  if (s === 'transparent') return '#00000000';
  if (s === 'white' || s === '#fff') return '#ffffff';
  if (s === 'black') return '#000000';
  return null;
}

/** Max per-channel difference (0-255) between two normalized colors, alpha included. */
export function colorDistance(a, b) {
  const ch = h => {
    const x = h.slice(1).padEnd(8, 'f');
    return [0, 2, 4, 6].map(i => parseInt(x.slice(i, i + 2), 16));
  };
  const [p, q] = [ch(a), ch(b)];
  return Math.max(...p.map((v, i) => Math.abs(v - q[i])));
}

/** Deprecated CSS names → replacements (see rename-map.json). */
export function loadRenameMap(root = PACKAGE_ROOT) {
  return readJson(path.join(root, 'rename-map.json'));
}
