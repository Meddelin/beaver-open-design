---
name: beaver-prototype
description: |
  React + TypeScript single-file prototype rendered against the live Beaver
  UI runtime. The prototype uses Beaver components as its primary surface
  and inner-DS primitives as a fallback when Beaver does not have what's
  needed. Component / prop / token details are pulled by tool calls, not
  baked into the prompt.
triggers:
  - "prototype"
  - "mockup"
  - "page"
  - "screen"
  - "интерфейс"
  - "макет"
  - "прототип"
od:
  mode: prototype
  platform: desktop
  scenario: design
  preview:
    type: react-tsx
    entry: index.tsx
    runtime: beaver
  design_system:
    requires: false
    fixed: beaver
---

# Beaver UI Prototype Skill

This skill produces a single self-contained `index.tsx` that renders
against the live Beaver UI runtime. The runtime is a pre-built UMD that
exposes every Beaver component, every primitive of the inner DS Beaver
consumes, and the design tokens — all on `window.Beaver`.

You are **not** writing CSS from scratch. You are **not** using arbitrary
HTML elements. You are composing components that already exist.

The base prompt and discovery layer (above this skill in your context)
already cover the conversation flow and the six hard rules. This skill
adds the composition workflow specific to the "Beaver UI prototype" use
case.

## Workflow

### Step 0 — Discovery and vocalization

This is owned by the discovery layer. By the time you start composing,
you should already have answered: type of screen, primary use-case, data
shape, required states, interaction points. If you skipped discovery,
go back and do it.

### Step 1 — Decompose the screen into roles

Before reaching for any component name, write down the abstract roles
the screen needs:

- shell (page chrome)
- top navigation
- side navigation (if any)
- subheader (if any)
- main content slot
- sub-component for each section type (table, card grid, form, …)
- modal / drawer / overlay (if any)
- empty state (if requested in turn 1)

Roles are layout-level. Don't pick component names yet.

### Step 2 — Map roles to components via tools

For each role:

1. `beaver_search_components(role + intent)` — e.g. "main page shell",
   "data table with filters", "card with header and actions".
2. Read the top 3-5 results. They come ordered with Beaver primary first.
3. If a Beaver component fits the role, pick it.
4. If nothing in Beaver fits, search again with broader keywords. If still
   nothing, only then look at fallback (`tier: 'fallback'`) results from
   inner-DS.
5. If neither has a fit, this is the "stop and ask" moment — name what's
   missing and ask the user. Do not invent.

For each chosen component:

- `beaver_get_component_spec(name)` — read the full spec. Note required
  props, enum values, sub-components from the same package.
- If the spec mentions `referencedTypes`, fetch those too — the type
  values may be enum strings you'll need.

### Step 3 — Tokens

For any visual values that aren't already exposed by component props
(spacings between layout regions, accent colors when picking a CTA
variant, transition durations, etc.):

- `beaver_list_token_groups()` — see what groups exist.
- `beaver_get_tokens(group)` — fetch the actual values.
- Use these via `import { spacing, color } from '@inner-ds/design-tokens'`
  (or sub-paths like `/colors`).

If the visual decision could be implemented either via a token or via
an inline value — token wins, every time. No exceptions.

### Step 4 — TodoWrite for anything multi-section

If the screen has more than one major region, kick off TodoWrite with
the build sequence. Update `in_progress → completed` as you finish
each region. The user sees this stream live; it's their progress
indicator.

### Step 5 — Compose, starting from the seed

`assets/template.tsx` is the smallest valid starting shape (Layout +
Header + Box). Copy it, then fill in. Build outermost-first:

1. Outer shell.
2. Top-level regions inside shell.
3. Per-region content.
4. Modal / drawer / overlay branches last.
5. Empty / loading / error state branches.

For sub-components (e.g. `HeaderTitle`, `SubheaderObjectTitle`): import
them in the same `import { … } from '@beaver-ui/<package>'` line as their
parent. They are NOT accessed via dot-notation (`Header.Title` is not a
Beaver pattern — always explicit named imports).

### Step 6 — Pre-emit dry_run

`beaver_dry_run(source)` is mandatory. The runtime will compile your TSX
with the real Beaver bundle in a headless environment and surface any
runtime error before the user sees it.

- `{ ok: true }` → emit the artifact.
- `{ ok: false, error }` → fix and rerun.

Most common dry_run failures and their fix:

- `X is not defined`: missing import. Check whether `X` is a sub-component
  of a parent you imported and add it to the same import statement.
- `Cannot read properties of undefined`: wrong prop access path; recheck
  spec.
- "Element type is invalid": something resolved to undefined in JSX,
  usually a typo in a component name.
- Babel parse error with line/col: a syntactic issue. Read the cited line
  carefully — most often a missing backtick on a template literal, or an
  unclosed JSX tag.

### Step 7 — Self-check (visible in chat)

Before emitting, write a short 5-bullet self-check in plain text so the
user sees your reasoning. Already covered in the discovery layer; do not
skip this step in the artifact-emit turn.

### Step 8 — Emit

`<artifact kind="react-component" entry="index.tsx">` block, single file,
default-export `Prototype`, imports at top, no narration after `</artifact>`.

## Resource map

```
beaver-prototype/
├── SKILL.md                          ← this file
├── assets/
│   └── template.tsx                  ← seed: minimal Layout + Header + Box (READ FIRST)
├── components.json                   ← lean manifest (names + package + tier + kind), auto-generated
├── specs/<Component>.json            ← full per-component spec, fetched via tool, auto-generated
├── tokens/<group>.json               ← per-group token values, fetched via tool, auto-generated
├── docs/<package>/<name>.md          ← per-component description corpus, auto-generated
└── references/
    └── layouts/                      ← hand-curated TSX recipes for common screen patterns
```

`components.json`, `specs/*`, `tokens/*`, `docs/**` are all generated by
`pnpm beaver:sync`. Don't edit them manually — your edits will be
overwritten.

`references/layouts/*.tsx` are hand-written and survive sync runs. Use
them as starting points for common patterns (hero, dashboard, table page,
form modal, etc).
