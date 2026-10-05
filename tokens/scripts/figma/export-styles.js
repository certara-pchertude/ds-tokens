// Read-only Figma Plugin API script: exports local effect styles and text styles.
// Save the returned JSON string to `figma-snapshot/raw/styles.json`.
const all = await figma.variables.getLocalVariablesAsync();
const byId = new Map(all.map(v => [v.id, v]));
const hex = c => {
  const h = x => Math.round(x * 255).toString(16).padStart(2, '0');
  return '#' + h(c.r) + h(c.g) + h(c.b) + (c.a !== undefined && c.a < 1 ? h(c.a) : '');
};
const bound = b => (b ? Object.fromEntries(Object.entries(b).map(([k, v]) => [k, byId.get(v.id)?.name ?? v.id])) : null);
const effects = (await figma.getLocalEffectStylesAsync()).map(s => ({
  name: s.name,
  description: s.description || null,
  effects: s.effects.map(e => ({
    type: e.type,
    visible: e.visible,
    color: e.color ? hex(e.color) : null,
    x: e.offset?.x ?? null,
    y: e.offset?.y ?? null,
    blur: e.radius ?? null,
    spread: e.spread ?? null,
    bound: bound(e.boundVariables),
  })),
}));
// Icon/* text styles (Font Awesome glyph sizes) are skipped.
const texts = (await figma.getLocalTextStylesAsync()).filter(s => !s.name.startsWith('Icon/')).map(s => ({
  name: s.name,
  family: s.fontName.family,
  style: s.fontName.style,
  size: s.fontSize,
  lineHeight: s.lineHeight.unit === 'AUTO' ? 'AUTO' : { unit: s.lineHeight.unit, value: s.lineHeight.value },
  letterSpacing: { unit: s.letterSpacing.unit, value: s.letterSpacing.value },
  decoration: s.textDecoration,
  bound: bound(s.boundVariables),
}));
return JSON.stringify({ effects, texts });
