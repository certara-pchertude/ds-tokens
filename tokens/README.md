# @certara/tokens

The source of truth for Certara design tokens. `src/` mirrors the variables in the **Certara Design Library** Figma file one to one, stored as [W3C DTCG](https://www.designtokens.org/) JSON. [`@certara/styles`](../styles) turns these tokens into CSS.

## Layout

```
src/<collection>/<mode>/<collection>.json   Figma variables, one folder per mode (Token Nexus reads this path)
extended/*.json                             tokens Figma can't hold as variables, or that only exist in code
collections.json                            collection names, mode order and default modes (kept outside src/)
rename-map.json                             old CSS names → new names, emitted as deprecated aliases
figma-snapshot/                             raw Figma extraction, used for the round-trip check
reports/discrepancies.md                    tokens vs certara-ui today: value diffs, renames, gaps, bugs
lib/index.mjs                               loader and resolver used by @certara/styles
```

- **Token paths are Figma variable names.** `color/text/primary` becomes `color.text.primary`. Spaces are kept (`"brand strong"`).
- **CSS names are derived mechanically:** lowercase, with `/`, `.` and spaces replaced by `-`. So `space/nav bar/padding y` becomes `--space-nav-bar-padding-y`.
- **Aliases** use DTCG references (`{theme.neutral.900}`), and may point across collections.
- **Dimensions are stored in px**, as in Figma, using the DTCG object form (`{ "value": 8, "unit": "px" }`). Token Nexus's sample repo (`Ojanti/mojaui-tokens`) uses the same form. `@certara/styles` decides whether to emit rem or px.
- **Figma metadata** lives in `$extensions["com.figma"]`: variable id, collection, scopes and codeSyntax. Nothing is lost on the way back to Figma.
- **`extended/`** holds:
  - shadows (generated from Figma effect styles)
  - heading line heights and weights
  - z-index
  - utility override hooks (`--border-width`, `--border-color`, `--link-color`)
  - component values that certara-ui declares on `:root`
  - a few color tokens that are missing in Figma

  Each extended token should eventually move to Figma or be deleted. See report §7.

## Updating from Figma

1. Run `scripts/figma/export-variables.js` in the Figma file through the Figma MCP `use_figma` tool, or a scratch plugin or the dev console.
   - Run it once with `COLLECTION = null` to get the metadata, saved as `figma-snapshot/raw/_meta.json`.
   - Then run it once per collection chunk (≤100 variables per run keeps each response small).
   - Save each result to `figma-snapshot/raw/<collection>-<from>.json`.
2. Run `scripts/figma/export-styles.js` the same way and save the result to `figma-snapshot/raw/styles.json`.
3. Run `npm run import:figma -w @certara/tokens`. This regenerates `src/`, `collections.json`, `figma-snapshot/variables.json` and `extended/shadow.json`.
4. Run `npm run build:styles`. This validates the tokens, then builds and verifies the CSS. Then run `npm run report:tokens` to refresh the report.

**Round-trip check** (proves `src/` equals Figma right now):

1. Run `scripts/figma/roundtrip-hash.js` in Figma and save its JSON.
2. Run `npm run roundtrip -w @certara/tokens -- <that-file>`.

Both sides hash the fully resolved value of every variable in every mode.

## Token Nexus

Token Nexus syncs token JSON from a **GitHub** repo into Figma variables. This repo is on Bitbucket, so wiring it up still needs a GitHub mirror. Not done yet.

1. Mirror `packages/tokens/src/` to a GitHub repo, e.g. from a Bitbucket Pipelines step on merges to `main`.
2. In Token Nexus, connect `owner/repo` on branch `main` with path `packages/tokens/src/` (or `/` if you mirror only `src/`). Use a fine-grained PAT with read-only *Contents* access.
3. Generate or map variables. Each `<collection>/<mode>/` folder is one mode of one collection.

Only `src/` belongs on that path. Nothing in `extended/`, `collections.json` or `rename-map.json` is a Figma variable.

The format (DTCG, hex colors, `{alias}` references, object dimensions) matches Token Nexus's sample repo. Still to test against the plugin itself:
- whether it preserves alias chains or writes resolved values
- whether it reads `$extensions["com.figma"]` scopes

## Scripts

| Script | What it does |
|---|---|
| `npm run import:figma` | raw snapshot → `src/`, `collections.json`, `extended/shadow.json` |
| `npm run validate` (= `build`) | snapshot parity, mode coverage, alias resolution in all 24 mode combinations, DTCG naming, CSS-name collisions, rename map |
| `npm run roundtrip -- <figma.json>` | compares against a fresh Figma read |
