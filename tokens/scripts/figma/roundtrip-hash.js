// Read-only Figma Plugin API script for the round-trip check (see scripts/roundtrip.mjs).
// Resolves every local variable per mode of its own collection (aliases into other collections use
// that collection's default mode) and returns an FNV-1a hash + count per collection/mode, plus the
// canonical lines when DETAIL names a collection.
const DETAIL = null;

const all = await figma.variables.getLocalVariablesAsync();
const byId = new Map(all.map(v => [v.id, v]));
const cols = await figma.variables.getLocalVariableCollectionsAsync();
const colById = new Map(cols.map(c => [c.id, c]));
const hex = c => {
  const h = x => Math.round(x * 255).toString(16).padStart(2, '0');
  return '#' + h(c.r) + h(c.g) + h(c.b) + (c.a !== undefined && c.a < 1 ? h(c.a) : '');
};
const resolveValue = async (v, modeId, depth = 0) => {
  if (depth > 20) throw new Error('alias depth > 20 at ' + v.name);
  const raw = v.valuesByMode[modeId];
  if (raw && typeof raw === 'object' && raw.type === 'VARIABLE_ALIAS') {
    let target = byId.get(raw.id);
    if (!target) {
      // Remote (library) alias: resolve to the local variable of the same name.
      const remote = await figma.variables.getVariableByIdAsync(raw.id);
      target = all.find(x => x.name === remote.name);
    }
    const sameCollection = target.variableCollectionId === v.variableCollectionId;
    const targetMode = sameCollection ? modeId : colById.get(target.variableCollectionId).defaultModeId;
    return resolveValue(target, targetMode, depth + 1);
  }
  if (typeof raw === 'object') return hex(raw);
  if (typeof raw === 'number') return String(Number(raw.toFixed(4)));
  return String(raw);
};
const fnv = s => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
};
const out = {};
for (const c of cols) {
  for (const m of c.modes) {
    const lines = [];
    for (const id of c.variableIds) {
      const v = byId.get(id);
      lines.push(`${v.name}\t${await resolveValue(v, m.modeId)}`);
    }
    lines.sort();
    out[`${c.name}/${m.name}`] = { count: lines.length, hash: fnv(lines.join('\n')), ...(DETAIL === c.name ? { lines } : {}) };
  }
}
// Effect styles and (non-icon) text styles, canonicalized the same way as scripts/roundtrip.mjs.
const r4 = n => String(Number(Number(n).toFixed(4)));
const effectLines = (await figma.getLocalEffectStylesAsync())
  .map(s => [s.name, ...s.effects.map(e => [e.type, e.visible, e.color ? hex(e.color) : '', r4(e.offset?.x ?? 0), r4(e.offset?.y ?? 0), r4(e.radius ?? 0), r4(e.spread ?? 0)].join(','))].join('|'))
  .sort();
const textLines = (await figma.getLocalTextStylesAsync())
  .filter(s => !s.name.startsWith('Icon/'))
  .map(s => [s.name, s.fontName.family, s.fontName.style, r4(s.fontSize), s.lineHeight.unit === 'AUTO' ? 'AUTO' : r4(s.lineHeight.value), r4(s.letterSpacing.value), s.textDecoration].join('|'))
  .sort();
out['Effect styles'] = { count: effectLines.length, hash: fnv(effectLines.join('\n')) };
out['Text styles'] = { count: textLines.length, hash: fnv(textLines.join('\n')) };
return out;
