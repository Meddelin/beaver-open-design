# Beaver UI component index

> **Auto-generated** by `pnpm beaver:sync`. Do not edit manually — your edits
> will be overwritten on the next sync. To extend the rules used by the
> generator, edit `packages/beaver-spec-extractor/`.

Once `beaver:sync` has run against your local Beaver checkout, this file
will list every available component grouped by tier and category, with a
one-line description and a link to its full spec under `./components/`.

Until then, read `../components.json` directly — it is the authoritative
manifest the LLM consumes.

## Tiers

- **`preferred`** — `@beaver-ui/*`. Use these whenever they fit the
  intent. They are the public API.
- **`primitive`** — `@<inner-ds>/components`. The DS Beaver consumes.
  Use ONLY as a fallback when no Beaver component (or composition of Beaver
  primitives) covers the case.

## Layout primitives (always available)

These are your composition vocabulary. Read their per-component specs first.

- `Box` — `@beaver-ui/box`
- `Flex` — `@beaver-ui/flex`
- `Grid` — `@beaver-ui/grid`
- `Layout` — `@beaver-ui/layout`

## Tokens

See [`./tokens.md`](./tokens.md) for the full catalog of design tokens
(`colors`, `spacing`, `typography`, `animation`).
