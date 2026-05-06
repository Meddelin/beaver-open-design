# `@beaver-open-design/beaver-runtime`

Vite library that bundles the Beaver UI surface into a single UMD file the
iframe preview consumes. The bundle exposes:

- every `@beaver-ui/*` component as a named export
- (after the inner-DS wiring is finished) every primitive of the inner DS
  Beaver consumes
- (after the inner-DS wiring is finished) `tokens` — the namespace of
  design tokens (`colors`, `spacing`, `typography`, `animation`)

It is loaded by the iframe via:

```html
<script src="/vendor/beaver.umd.js"></script>
<link rel="stylesheet" href="/vendor/beaver.css" />
```

…and exposed as `window.Beaver`. The srcdoc import-rewriter in
[`apps/web/src/runtime/srcdoc.ts`](../web/src/runtime/srcdoc.ts) translates
LLM-emitted `import { Foo } from '@beaver-ui/<pkg>'` into
`const { Foo } = window.Beaver` at preview time.

## Build

```bash
# Requires .npmrc with auth for the private Beaver registry — see root README.
pnpm install
pnpm --filter @beaver-open-design/beaver-runtime build
```

After build, `dist/beaver.umd.js` and `dist/beaver.css` are copied into
`apps/web/public/vendor/` automatically.

## Wiring the inner DS

After `pnpm install` resolves the Beaver dependency graph:

1. Inspect `node_modules/@beaver-ui/components/package.json` to find the
   scope name of the inner DS that Beaver consumes (and its
   `design-tokens` package).
2. Edit `package.json` here — add `@<inner-ds>/components` and
   `@<inner-ds>/design-tokens` (and any other inner-DS sub-packages) to
   `dependencies`.
3. Edit `src/index.ts` — uncomment the inner-DS export block, replacing
   `<inner-ds>` with the real scope.
4. Re-run `pnpm install && pnpm --filter @beaver-open-design/beaver-runtime build`.
5. Re-run `pnpm beaver:sync` so the spec extractor can also see the
   inner-DS package and write the right import statements into
   `skills/beaver-prototype/components.json`.

When you bump Beaver or the inner DS, run:

```bash
pnpm up '@beaver-ui/*' '@<inner-ds>/*' && \
  pnpm beaver:sync && \
  pnpm --filter @beaver-open-design/beaver-runtime build
```
