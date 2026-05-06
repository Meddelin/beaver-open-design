# `@beaver-open-design/spec-extractor`

CLI that scans local source checkouts of Beaver UI and the inner DS Beaver
consumes, then writes:

- `skills/beaver-prototype/components.json` — machine-readable manifest.
- `skills/beaver-prototype/references/components/<Name>.md` — per-component
  spec the LLM reads.
- `skills/beaver-prototype/references/tokens.md` — design-token catalog.
- `skills/beaver-prototype/references/index.md` — grouped overview.

## Usage

```bash
pnpm beaver:sync \
  --beaver /path/to/local/beaver-ui-checkout \
  --inner  /path/to/local/inner-ds-checkout
```

`--inner` is optional. When omitted, the extractor runs against Beaver only
and `references/tokens.md` stays empty until you point it at a tokens
package on the next run.

## How it works

For each `packages/*` it finds:

1. Parses `*.stories.{ts,tsx}` to discover the component name (looks for
   `component: Foo` in the CSF meta).
2. Falls back to scanning `src/index.{ts,tsx}` exports if no stories are
   present.
3. Loads the package's TypeScript with `ts-morph` and finds prop interfaces
   matching `FooProps` / `IFooProps`. Extracts each prop's name, type
   text, required flag, JSDoc summary, and string-literal union values.
4. For the `design-tokens` package: parses each top-level `export const` and
   captures its right-hand value (numbers, strings, JSON-shaped objects).

The extracted data is then merged, deduped, sorted (Beaver tier first), and
written to disk.

## Limitations

- **Storybook MDX is not parsed** — only CSF stories. If your inner-DS
  documentation is mostly MDX, expect empty `examples` arrays. Future work:
  add an MDX → snippet extractor.
- **JSDoc summaries** are best-effort: only the description block of a
  property is captured, not param tags or remarks.
- **Token RHS parsing** is regex + light JSON normalisation. Complex
  expressions (function calls, computed keys) fall back to the raw source
  text. The full type definitions in `*.d.ts` remain authoritative — we
  only need the values to surface examples to the LLM.

The output is idempotent: rerunning `beaver:sync` overwrites every file the
extractor writes. Hand-edits in `skills/beaver-prototype/references/components/`
or `references/tokens.md` will be lost. If you need to keep custom guidance,
put it in `SKILL.md` or in `references/layouts/`.
