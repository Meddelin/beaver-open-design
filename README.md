# beaver-open-design

Fork of [`nexu-io/open-design`](https://github.com/nexu-io/open-design)
that generates UI prototypes using **only** the corporate Beaver UI
design system (`@beaver-ui/*`).

The LLM emits a single React + TypeScript file. The preview loads a
pre-built UMD of the live Beaver runtime (and the inner DS Beaver
consumes), then renders the component into a sandboxed iframe — so the
prototype is visually and behaviourally identical to production code.

## What's different from upstream

| | upstream `nexu-io/open-design` | this fork |
|---|---|---|
| Output | self-contained HTML with bespoke CSS classes | single `index.tsx` importing only `@beaver-ui/*` and inner-DS tokens |
| Component vocabulary | inferred from a `DESIGN.md` description | enumerated from the live source repo via `pnpm beaver:sync` |
| Design systems | 70+ presets | exactly one: `beaver` |
| Skills | 31 | exactly one: `beaver-prototype` |
| Renderer | unpkg React + freeform HTML in iframe | unpkg React + Babel + `/vendor/beaver.umd.js` + import-rewriter |

The behavioural rules pinned into the system prompt
([`apps/daemon/src/prompts/beaver-system.ts`](apps/daemon/src/prompts/beaver-system.ts)):

1. Imports come **only** from `@beaver-ui/*`, `@tui-react/components`,
   `@tui-react/design-tokens`, or `react`.
2. Components / props / variants come **only** from the synced manifest
   ([`skills/beaver-prototype/components.json`](skills/beaver-prototype/components.json)).
3. **Fallback ladder**: Beaver → Beaver primitives composition → inner-DS
   primitive → STOP and ask the user. No silent invention.
4. **Style overrides**: only via tokens imported from
   `@tui-react/design-tokens`. No hardcoded hex / px / font names.

## Setup

### 1. Auth for the private registry

`@beaver-ui/*` and the inner-DS packages live on a private npm registry.
Add auth to your **user-level** `~/.npmrc` (or `%USERPROFILE%\.npmrc` on
Windows) — the fork does **not** commit any credentials:

```ini
@beaver-ui:registry=https://your-private-registry.example.com/
//your-private-registry.example.com/:_authToken=YOUR_TOKEN
# repeat for the inner-DS scope once you know its name
```

If you don't yet know the inner-DS scope name, install Beaver first and
look at `node_modules/@beaver-ui/components/package.json` to discover it.

### 2. Install

```bash
pnpm install
```

### 3. Wire the inner DS into the runtime

After install, edit two files to point at your inner DS scope:

- [`apps/beaver-runtime/package.json`](apps/beaver-runtime/package.json) —
  add `@tui-react/components` and `@tui-react/design-tokens` to
  `dependencies`.
- [`apps/beaver-runtime/src/index.ts`](apps/beaver-runtime/src/index.ts) —
  uncomment the inner-DS export block, replacing `<inner-ds>` with the
  real scope.

Re-run `pnpm install`.

### 4. Sync component specs

Clone the Beaver UI source repo and the inner DS source repo to your
machine, then:

```bash
pnpm beaver:sync -- --beaver /path/to/beaver-ui-checkout --inner /path/to/inner-ds-checkout
```

This (re)generates:

- `skills/beaver-prototype/components.json`
- `skills/beaver-prototype/references/components/*.md`
- `skills/beaver-prototype/references/tokens.md`
- `skills/beaver-prototype/references/index.md`

`beaver:sync` is idempotent — rerun it whenever you bump `@beaver-ui/*`
or the inner DS.

### 5. Build the runtime UMD

```bash
pnpm beaver:build-runtime
```

This produces `apps/beaver-runtime/dist/beaver.umd.js` and `beaver.css`,
then copies them into `apps/web/public/vendor/` for the iframe to
consume as `/vendor/beaver.umd.js` and `/vendor/beaver.css`.

A combined script does steps 4 + 5 in one shot:

```bash
pnpm beaver:refresh
```

### 6. Run

```bash
pnpm --filter daemon dev    # in one terminal
pnpm --filter web dev       # in another
```

Open the URL printed by `web`, create a project, and prompt:
"набросай страницу со списком заявок: header + sidenav + filter table".
You should see the LLM emit `import { Header } from '@beaver-ui/header';`
etc., and the iframe render real Beaver components.

## Repository layout

| Path | Role |
|---|---|
| `apps/daemon/` | Backend daemon (Node + Express + SQLite). Spawns the coding-agent CLI, streams artifacts. |
| `apps/web/` | Next.js frontend. Renders chat, files, sandboxed preview iframe. |
| `apps/beaver-runtime/` | **NEW.** Vite library that bundles `@beaver-ui/*` + inner-DS + tokens into `beaver.umd.js`. |
| `packages/beaver-spec-extractor/` | **NEW.** CLI that scans local Beaver / inner-DS checkouts and writes the manifest + reference docs. |
| `skills/beaver-prototype/` | The single skill the daemon uses. SKILL.md, seed `template.tsx`, manifest, references. |
| `design-systems/beaver/DESIGN.md` | The single design-system entry. Authority chain documented; tokens are not duplicated here. |

Upstream apps (`apps/desktop`, `apps/landing-page`, `apps/packaged`) are
left in place but unused for this fork.

## Verification

Smoke tests to run after a fresh setup:

| # | Prompt | Expected |
|---|--------|----------|
| 1 | "форма входа с логином, паролем и кнопкой" | TSX with `Form`, `Input`, `Button` from `@beaver-ui/*`. Visually identical to Storybook. |
| 2 | "дашборд: header + sidenav + таблица заявок" | `Header`, `SideNavigation`, `Layout`, `FilterTable`/`Table`. |
| 3 | "гистограмма продаж по месяцам" (no chart in Beaver) | LLM stops and asks for permission before writing custom code. |
| 4 | "карточка с padding 13px и розовой рамкой" | LLM picks closest `spacing.*` and `colors.accent.*`, refuses hardcode. |
| 5 | Drawer / Popover / FormModal in any prompt | Portal mounts inside the iframe. |
| 6 | LLM emits `<Button variant="superprimary">` (not in manifest) | Self-check rejects before emit; if it slips through, the iframe renders an error. |

If the iframe shows "Beaver runtime not loaded", the build copy step
didn't run — re-run `pnpm beaver:build-runtime`.

## License

Apache-2.0, same as upstream.
