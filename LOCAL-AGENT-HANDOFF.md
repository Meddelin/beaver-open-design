# Local-agent handoff: what remains for v2

This document describes the work the remote (Claude) could not complete
because it requires either:

- access to the **internal qwen-code fork** (NDA-locked, not on the
  remote machine), or
- ability to **run the actual Beaver bundle** with real components (not
  scaffolds), or
- **end-to-end testing** with a live agent loop.

The remote's three v2 commits land structural rewrites:

1. `49ddc54` — prompt stack (discovery + base + skill + lean component
   index + tools manifesto), iframe runtime errors via postMessage,
   L1-only validator.
2. `<commit-2>` — spec extractor v2 (bundle introspection + TS Compiler
   API + tokens + docs).
3. `<commit-3>` — `apps/daemon/src/beaver-tools.ts` (six tools as
   protocol-neutral functions) + `mcp-beaver-tools-server.ts` (MCP
   transport) + `od beaver-mcp` CLI entry.

Below is everything left.

## Phase 0 — qwen-code fork integration

The MCP server (`od beaver-mcp --skill-dir …`) is ready and follows the
standard MCP protocol. What's needed:

### 0.1 Verify MCP support in qwen-code

Read the qwen-code fork's docs / source to confirm:

- It supports MCP servers via `--mcp <path>` or a config file pointing to
  servers.
- It calls `tools/list` on startup and exposes the returned tools to the
  model.
- It calls `tools/call` with `{ name, arguments }` shape (standard MCP).
- It feeds tool outputs back into the conversation as `tool` role
  messages (standard).

If yes — add a config entry pointing at `od beaver-mcp` and proceed.

If no — either:

(a) Patch the fork to support standard MCP (preferred — opens the door
to other Open Design tools like `od mcp`).
(b) Adapt the daemon to expose tools via whatever native protocol the
fork uses. Re-implement the dispatch in
`apps/daemon/src/mcp-beaver-tools-server.ts`'s shape.

### 0.2 Without-yolo mode auto-confirm

In without-yolo, qwen-code asks for confirmation on certain actions
(write-file, run-command, etc.). For our pipeline this is friction —
the agent needs to write the artifact file silently, retry on errors
silently, etc.

Find how the fork signals confirmation requests:

- Stdout JSON event with a known shape?
- A specific stderr line?
- A blocking prompt?

Wire the daemon to auto-confirm any request originating from inside an
agent run. If the fork does not have a programmatic auto-confirm
mechanism, ask the fork maintainers to add one (or a `--yes-everything`
mode the daemon can pass when spawning).

### 0.3 Remove non-qwen agent code

Per plan §5: delete from `apps/daemon/src/`:

- `claude-stream.ts`, `copilot-stream.ts`, `qoder-stream.ts`, any other
  per-CLI stream handlers.
- `codex-pets.ts`, `community-pets-sync.ts`, `claude-design-import.ts`.
- BYOK proxy logic (search for `BYOK`, `proxyOpenAI`, similar).
- All branches in `agents.ts` that enumerate / detect non-qwen CLIs.
  Reduce to a single `AgentDef` for the corp qwen-code fork.

The composer in `system.ts` already accepts an `agentId` it ignores;
keep that signature for now to minimize ripple.

## Phase 5 — web auto-correction loop

The iframe now postMessages errors to the parent (`od:beaver-runtime-error`).
The parent web app must:

1. Subscribe to `message` events on the iframe's contentWindow.
2. Discriminate `od:beaver-runtime-error` events and **NOT show the user**
   the error UI. The chat preview pane should keep showing the
   "generating" indicator.
3. Form a correction prompt (use `renderBeaverCorrectionPrompt` from
   `@open-design/contracts` for the structured shape — same prefix the
   discovery prompt's self-correction protocol references).
4. POST to the chat API as a synthetic user-turn (or whatever the chat
   API calls "auto-correction"). Mark it so it doesn't appear in the user-
   visible transcript; it's bookkeeping between web → daemon → agent.
5. When the next artifact arrives, replace the iframe's `srcdoc`. New
   render starts; same listener fires again on the new iframe.
6. Cap retries at 5. After that, surface a soft message:
   "Не удалось собрать прототип. Сформулируйте запрос проще или попробуйте
   ещё раз." Do not show stack traces.

Files to touch:

- `apps/web/src/components/FileViewer.tsx` (or wherever the iframe is
  mounted) — add the message listener and retry counter.
- The "generating" UI state needs to support "still generating, on
  attempt 2 of 5" — informative without scary errors.
- Chat client / SSE handler — add a path for synthetic correction-turn
  POSTs that the daemon can distinguish from real user turns.
- Daemon side: `apps/daemon/src/server.ts` chat handler — accept a
  `kind: 'auto-correction'` flag or similar, treat the message as a
  user turn for the agent but suppress it from the transcript that's
  sent back to the web client.

The `[automated correction request]` text marker in the prompt is what
the discovery layer's self-correction protocol references; using that
marker lets the agent recognize the turn.

## Phase 1 — testing the spec extractor

The extractor was written without the ability to run against real
Beaver. Expect rough edges. Test sequence:

1. `pnpm install` (with proper auth for the private registry; ensure the
   inner-DS scope packages also land in `node_modules`).
2. `pnpm beaver:build-runtime` — must succeed and produce
   `apps/beaver-runtime/dist/beaver.umd.js`. If the bundle can't be
   built (inner-DS exports issues, jsx-runtime issues), fix those first
   before proceeding.
3. `pnpm beaver:sync` (without `--beaver` / `--inner` first — checks
   that bundle introspection + props + tokens work from `node_modules`
   alone).
4. Verify outputs:
   - `skills/beaver-prototype/components.json` has hundreds of
     components, all with `tier: 'primary' | 'fallback'` and
     `kind: 'unknown'`.
   - `skills/beaver-prototype/specs/<Name>.json` exists for each. Open
     a few — they should have non-empty `props` arrays for components
     with explicit interfaces; empty arrays for components without are
     acceptable v1 baseline.
   - `skills/beaver-prototype/tokens/<group>.json` populated.
5. `pnpm beaver:sync --beaver <path> --inner <path>` to add the docs
   corpus from source checkouts. Verify
   `skills/beaver-prototype/docs/<package>/<Component>.md` files appear.

Likely rough edges to fix in order of probability:

- **JSDOM bundle load throws.** Some Beaver/inner-DS modules may
  evaluate code on import that JSDOM doesn't support. Inspect the
  exception in `introspect-bundle.ts`'s `loadBundleInJsdom`. If it's
  about a missing browser API, polyfill it on the JSDOM window before
  appending the script. If it's deep, replace JSDOM with a Playwright
  shim.

- **`name → package` resolution misses sub-packages.** The current
  approach reads `apps/beaver-runtime/package.json` for runtime deps.
  If sub-packages aren't directly listed (some monorepos hoist them),
  walk the resolved `node_modules/@beaver-ui/*` and
  `node_modules/<innerScope>/*` directories explicitly.

- **TS Compiler API returns synthetic types for utility types.** If a
  prop type comes out as something like `{}` because `Omit<X, Y>`
  resolved to an unrepresentable shape, fall back to capturing the
  textual representation directly (`type.aliasSymbol?.escapedName`)
  and ship that as the `type` field. The model can read it as text.

- **Token extraction returns nothing.** If the inner-DS's
  design-tokens package wraps values in a function call or computed
  property, the `walkObjectType` in `extract-tokens.ts` may bottom
  out at "Generic". Inspect the shape and extend the walker — common
  fix is to add a `getCallSignatures()` branch that resolves calls
  with no args.

- **Doc extraction picks up internal helpers.** The JSDoc scanner
  matches anything that looks like an exported PascalCase, including
  utility components. Add a filter: only emit a doc file for names
  that appear in the manifest (i.e. were classified as `component`
  by introspect-bundle).

## Phase 2 — kind classification (optional)

`pnpm beaver:classify` is referenced in the plan but not implemented.
Skeleton:

- Read the manifest.
- For each component with `kind: 'unknown'`, prepare a small payload:
  `{ name, package, oneLineDescription, propNames }`.
- Call the same agent (qwen-code) through a minimal wrapper, asking
  for one of: `layout | input | feedback | overlay | data-display |
  navigation | typography | media | utility | unknown`.
- Write back into `components.json`.

Cost: ~$0.001 per component if model is cheap; ~$1.50 for 1500
components. One-time per Beaver release.

This is genuinely "nice to have" — the manifest works fine with all
`kind: 'unknown'`. Defer until other things are stable.

## Wired-up `beaver_dry_run`

`apps/daemon/src/beaver-tools.ts` has `BeaverToolsContext.dryRun?`. The
MCP server (`mcp-beaver-tools-server.ts`) accepts a dryRun option but
the CLI entry does not pass one yet. To complete:

1. Implement a function that:
   - Loads `apps/beaver-runtime/dist/beaver.umd.js` once (cache the
     window-state in a JSDOM, or boot a headless Playwright tab on
     first call).
   - Receives TSX source.
   - Runs the same `rewriteBeaverImports` + `prepareReactComponentSource`
     that the iframe uses, then `Babel.transform`, then `eval` and
     `ReactDOM.createRoot(...).render()`.
   - Returns `{ ok: true }` or `{ ok: false, reason, message }`.
2. Pass it through `od beaver-mcp` startup. Add a `--dry-run-impl`
   flag accepting `jsdom` (in-process) or `playwright` (subprocess).

Without a wired dryRun, `beaver_dry_run` returns `{ ok: false,
reason: 'unavailable' }`. The agent will still try to emit the
artifact, and the iframe's runtime-error postMessage path will catch
it. dry_run is the *fast* path; runtime is the *correct* path. So this
is an optimization, not a blocker.

## What's deliberately out of scope

- **UMD bundle size optimization** (currently 8.6 MB). Plan §8.
- **Visual regression testing** on rendered prototypes.
- **Schema validation** of `components.json` shape via a JSON Schema or
  Zod. Not needed — extractor controls the shape.
- **Caching of bundle introspection results.** The current flow always
  runs JSDOM. If `pnpm beaver:sync` becomes slow, cache by bundle
  content hash.

## Verification checklist before declaring v2 done

- [ ] Phase 0.1 — qwen-code consumes `od beaver-mcp` MCP server, lists 6
      tools, calls them.
- [ ] Phase 0.2 — agent loop runs without manual confirms.
- [ ] Phase 0.3 — non-qwen code removed; daemon spawns qwen and only
      qwen.
- [ ] Phase 1 — `pnpm beaver:sync` produces a complete
      `components.json` with the expected components in it (including
      ones the v1 extractor missed). Manifest file size < 200 KB.
- [ ] Phase 5 — iframe runtime errors do NOT reach the user; auto-
      correction loop runs through 5 attempts; user sees only successful
      previews or the soft "couldn't generate" message.
- [ ] Smoke test: prompt "форма входа" → discovery turn → vocalization
      → tools called → artifact emitted → renders. Single happy path
      end to end.
- [ ] Smoke test: prompt for a chart-like component → agent searches,
      doesn't find, asks user. Does NOT invent a SVG.
- [ ] Smoke test: deliberately prompt that triggers an LLM hallucination
      (sub-component name) → first attempt errors → second attempt
      after auto-correction succeeds → user sees only the second one.
