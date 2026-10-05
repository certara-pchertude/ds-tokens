// Read-only Figma Plugin API script: exports local variables in compact chunks.
//
// Run via the Figma MCP `use_figma` tool (or a scratch plugin / dev console) against the
// Certara Design Library file. Set the three params below, run once per chunk, and save each
// returned JSON string to `figma-snapshot/raw/<collection-slug>-<from>.json`. Then run
// `node scripts/assemble-snapshot.mjs` to build `figma-snapshot/variables.json`.
//
// With COLLECTION = null the script returns only collection metadata (use it to plan chunks).
//
// Item encoding (keeps each response under the MCP 20 KB limit):
//   [id, name, type, valuesByMode[], scopes|null, description|null, codeSyntax|null]
//   id     — VariableID without the "VariableID:" prefix
//   type   — C(OLOR) F(LOAT) S(TRING) B(OOLEAN)
//   value  — "#rrggbb" / "#rrggbbaa" for colors, number / string / boolean otherwise,
//            or {"alias": "<target variable name>"} / {"alias": null, "ext": "<id>"} for aliases
//   scopes — null when equal to the collection's most common scope set
const COLLECTION = null;
const FROM = 0;
const TO = 1000;

const all = await figma.variables.getLocalVariablesAsync();
const byId = new Map(all.map(v => [v.id, v]));
const cols = await figma.variables.getLocalVariableCollectionsAsync();
const hex = c => {
  const h = x => Math.round(x * 255).toString(16).padStart(2, '0');
  return '#' + h(c.r) + h(c.g) + h(c.b) + (c.a !== undefined && c.a < 1 ? h(c.a) : '');
};
const encode = val => {
  if (val && typeof val === 'object' && val.type === 'VARIABLE_ALIAS') {
    const t = byId.get(val.id);
    return t ? { alias: t.name } : { alias: null, ext: val.id };
  }
  return typeof val === 'object' ? hex(val) : val;
};
const scopeKey = v => v.scopes.join(',');
const commonScopes = col => {
  const counts = {};
  for (const id of col.variableIds) {
    const k = scopeKey(byId.get(id));
    counts[k] = (counts[k] || 0) + 1;
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
};

if (!COLLECTION) {
  const names = all.map(v => v.name);
  const dupes = names.filter((n, i) => names.indexOf(n) !== i);
  return {
    total: all.length,
    duplicateNames: dupes,
    collections: cols.map(c => ({
      name: c.name,
      id: c.id,
      hidden: c.hiddenFromPublishing,
      modes: c.modes.map(m => m.name),
      defaultMode: c.modes.find(m => m.modeId === c.defaultModeId).name,
      count: c.variableIds.length,
      scopes: commonScopes(c),
    })),
  };
}

const col = cols.find(c => c.name === COLLECTION);
const common = commonScopes(col);
const ids = col.variableIds.slice(FROM, TO);
const items = ids.map(id => {
  const v = byId.get(id);
  const cs = v.codeSyntax && Object.keys(v.codeSyntax).length ? v.codeSyntax : null;
  return [
    v.id.replace('VariableID:', ''),
    v.name,
    v.resolvedType[0],
    col.modes.map(m => encode(v.valuesByMode[m.modeId])),
    scopeKey(v) === common ? null : v.scopes,
    v.description || null,
    cs,
  ];
});
return JSON.stringify({ collection: col.name, from: FROM, to: FROM + items.length, total: col.variableIds.length, items });
