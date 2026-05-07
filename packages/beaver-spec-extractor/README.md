# `@beaver-open-design/spec-extractor`

Pipeline that gathers all the design-system context the daemon's
`beaver-tools` layer needs:

- `skills/beaver-prototype/components.json` — lean manifest (names + tier + kind + paths to spec / docs).
- `skills/beaver-prototype/specs/<Component>.json` — full per-component spec (props, examples, referenced types).
- `skills/beaver-prototype/tokens/<group>.json` — token group values.
- `skills/beaver-prototype/tokens/index.json` — list of token groups.
- `skills/beaver-prototype/docs/<package>/<Component>.md` — per-component doc corpus.

## Usage

```bash
# minimal (no docs, but components + tokens still extracted from node_modules)
pnpm beaver:sync

# full
pnpm beaver:sync \
  --beaver /path/to/local/beaver-ui-checkout \
  --inner  /path/to/local/inner-ds-checkout
```

Run **after** `pnpm beaver:build-runtime` — the bundle is the source of
truth for "what's actually exported"; without it, `introspect-bundle`
fails immediately.

## Phases

1. **Bundle introspection (`introspect-bundle.ts`)** — load
   `apps/beaver-runtime/dist/beaver.umd.js` in a JSDOM sandbox, enumerate
   `Object.keys(window.Beaver)`, classify each export
   (`component | hook | utility | tokens-namespace`), then resolve each
   name back to its source package by dynamically importing the
   runtime's `dependencies` and matching exports.
2. **Prop extraction (`extract-props.ts`)** — for each (package, names[])
   pair, walk the package's published `dist/index.d.ts` via the
   TypeScript Compiler API. Captures name, type-as-text, required flag,
   default expression, JSDoc summary, string-literal-union enum values,
   and cross-package referenced types.
3. **Token extraction (`extract-tokens.ts`)** — find the inner-DS
   design-tokens package, walk each top-level export's type via TS API,
   produce flat `{ path, value }` entries. Frozen objects are followed
   into their leaves.
4. **Docs extraction (`extract-docs.ts`)** — scan local source checkouts
   (`--beaver` and/or `--inner`) for MDX, top-level JSDoc on exported
   declarations, and package-root READMEs. Produces one Markdown file
   per component the daemon's `beaver_search_docs` tool searches.

## Why we changed the approach (v1 → v2)

- **v1 parsed Storybook stories with regex + ts-morph.** Hybrid story
  formats and sub-components in separate files made the manifest
  incomplete (missed ~10% of components).
- **v2 trusts the bundle.** What's exported on `window.Beaver` is what's
  available in preview, period. Introspection is exact, not heuristic.
- **v1 emitted per-component reference Markdown the daemon inlined into
  the prompt.** That ate 100k+ tokens of context.
- **v2 splits the manifest into a lean index (names only) + per-file
  specs the daemon serves lazily via `beaver_get_component_spec(name)`
  tool calls.** Prompt size drops from ~500 KB to ~30 KB.
- **v1's token extractor was regex.** v2 uses TS Compiler API on the
  package's `.d.ts`, so it handles frozen objects and computed values.

## Limitations

- **MDX → example snippets is not implemented.** v2 captures MDX as
  doc-corpus text but does not pull TSX snippets out of it for
  `examples`. Adding that is a follow-up.
- **`kind` field in the manifest is `unknown` after sync.** Classifying
  what each component is for (layout / input / overlay / …) requires an
  LLM pass — run `pnpm beaver:classify` separately when you want labels.
- **Cross-package referenced types are linked but not auto-resolved.**
  The model has to call `beaver_get_component_spec(typeName)` itself to
  pull the value of a referenced type.

## Output is idempotent

Rerunning `beaver:sync` overwrites every file it generates. Hand-edits
in `components.json`, `specs/`, `tokens/`, or `docs/` will be lost.
Custom guidance lives in `SKILL.md` and `references/layouts/`.
