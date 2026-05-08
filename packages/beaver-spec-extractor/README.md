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
   `apps/beaver-runtime/dist/beaver.umd.js` in a sandboxed runtime
   (JSDOM by default; Playwright opt-in via `--introspector playwright`),
   enumerate `Object.keys(window.Beaver)`, classify each export
   (`component | hook | utility | tokens-namespace`), then resolve each
   name back to its source package by dynamically importing the
   runtime's `dependencies` and matching exports.

   The JSDOM path provides a full React/ReactDOM/jsx-runtime stub plus
   DOM polyfills (ResizeObserver, IntersectionObserver, matchMedia,
   rAF, process.env) so a typical DS bundle's eager init code runs
   without throwing. Errors during script execution are *collected* and
   become part of the thrown exception when introspection fails — you
   never get a silent "0 components" result without diagnostics.

   Use `--introspector playwright` if the JSDOM path returns "Bundle
   is empty" with no actionable stack — that usually means the bundle
   uses a DOM API JSDOM doesn't emulate. Playwright requires
   `pnpm add -D -w playwright && pnpm exec playwright install chromium`
   one-time.
2. **Prop extraction (`extract-props.ts`)** — for each (package, names[])
   pair, walk the package's published `dist/index.d.ts` via the
   TypeScript Compiler API. Captures name, type-as-text, required flag,
   default expression, JSDoc summary, string-literal-union enum values,
   and cross-package referenced types. The TS program is created with
   React's `.d.ts` as an additional rootName so type names like
   `ForwardRefExoticComponent`/`FC` resolve. AST-based fallback walks
   the .d.ts directly when checker resolution still fails. Use
   `--debug-component <Name>` to see per-step diagnostics for one
   component.
3. **Token extraction (`extract-tokens.ts`)** — primary path:
   dynamic `import()` of the design-tokens JS module → `Object.entries`
   walk → flat `{ path, value }` entries. This works regardless of how
   the publisher's .d.ts looks (even `export const designTokens: any`
   produces real values). Fallback path: TS Compiler API on the .d.ts
   when dynamic import fails (rare).
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
