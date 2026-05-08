# Local-agent handoff: completing v2

This document is the operator's guide for the **local agent** finishing
the v2 rewrite. The remote (Claude) shipped three commits with the
structural changes; this document tells you how to bring them online,
what to verify, what to do when the remote-authored code misbehaves,
and what work remains for you to author yourself.

Remote's v2 commit chain:

1. `49ddc54` — prompt stack (discovery + designer-base + skill + lean
   component index + tools manifesto), iframe runtime errors via
   postMessage, L1-only validator.
2. `2bb095d` — spec extractor v2 (bundle introspection + TS Compiler
   API for props and tokens + docs corpus).
3. `7b83bb3` — `beaver-tools` (six DS tools as protocol-neutral
   functions) + `mcp-beaver-tools-server` (MCP transport) + `od
   beaver-mcp` CLI entry + this handoff doc.
4. `c918a89` — REMOTE-FIX-QUEUE #1 + #2 (JSDOM diagnostics, TS Compiler
   API method-vs-checker mistake).
5. **(latest)** — REMOTE-FIX-QUEUE #4–#8: empty props extraction, token
   "any" values, low component count, missing docSummary, MCP server
   no-response. See `REMOTE-FIX-QUEUE.md` for per-fix root-cause
   analyses.

Two key behavior changes from the local agent's first run:

- **Field rename: `description` / `oneLineDescription` → `docSummary`.**
  Both `ComponentSpec` and `ManifestEntry` now use `docSummary`. The
  local agent had been querying `.docSummary` and getting null because
  the field was called `description`. Same name everywhere now.

- **Inner-DS scope is `@tui-react`.** Substituted across
  `apps/beaver-runtime/{src/index.ts, package.json}`,
  `apps/web/src/runtime/beaver-component.ts`,
  `packages/beaver-spec-extractor/src/{cli.ts, sync.ts, extract-tokens.ts}`,
  and `skills/beaver-prototype/SKILL.md`. The previous `@inner-ds`
  placeholder is gone. If you need a different scope, do a global
  search-and-replace for `@tui-react` (note: do NOT replace
  occurrences in REMOTE-FIX-QUEUE.md — those are historical log
  entries).

---

## 0. Issue-handling policy (read first)

Some of the remote-authored code was written without the ability to run
it against the real Beaver, real qwen-code, or real inner-DS. Expect
issues. The way you handle them matters:

### Rule 1: don't silently fix remote-authored code

Remote-authored files are listed in `REMOTE-FIX-QUEUE.md`. When you
encounter a problem in any of them — type-check error, wrong output,
runtime crash, mis-resolved type, dead branch, anything — **do not
patch it**. Even if the fix looks obvious. Even if the patch is one
line.

The reason: remote-authored code was written with a specific
architectural intent. Local fixes drift the intent over time, and the
remote loses the ability to reason about the system. We've already been
through that cycle once in v1 and it cost us.

Instead, append an entry to `REMOTE-FIX-QUEUE.md` following the format
in that file. Be specific: file, line, symptom, repro, severity, and
notes for the remote. The remote will work through the queue as a
batch.

### Rule 2: if blocked, apply a marked workaround — not a fix

If an issue is blocking and you can't progress without changing the
code, you may apply a workaround. But:

- Add a comment tagged `TEMP-WORKAROUND #<N>` referencing the queue
  entry number.
- Keep the diff minimal — the goal is to unblock, not to be correct.
- Add the workaround to the same queue entry under "Workaround
  applied".

The remote will revert workarounds when it lands the proper fix.

### Rule 3: code you author is yours to maintain

The handoff sections below describe work that's intentionally left to
you (qwen-code wiring, web auto-correction loop, Playwright dryRun
runner). Code you author there — fix freely, refactor freely, the
queue does not apply.

---

## 1. Quick-start runbook

Run these in order. Each step has a verification gate; if a gate fails,
file the issue in the queue (per the policy above) and decide whether
to halt or continue.

### Step 1.1 — Install

```bash
pnpm install
```

**Prereqs:** your `~/.npmrc` has auth tokens for the private registry
serving `@beaver-ui/*` and the inner-DS scope. Without auth, `pnpm
install` fails on those packages — that's a setup issue, not a fork
issue.

**Verify:**

```bash
test -d node_modules/@beaver-ui/components && echo OK
ls node_modules/@beaver-ui | head        # should list ~30 sub-packages
```

If `node_modules/@beaver-ui/components/package.json` shows version
`0.0.0-stub`, something is wrong with the registry — those are stub
versions, not real Beaver. Fix `.npmrc` and re-install before
continuing.

### Step 1.2 — Inner-DS scope discovery

> **v2.1 update:** the inner-DS scope is now hardcoded as `@tui-react`
> across all code/skill/prompt files based on the local agent's first
> sync (queue entry #3). If your fork uses a different scope name,
> follow Step 1.3 substitution. If it really is `@tui-react` — Step 1.3
> is a no-op, skip it.

```bash
cat node_modules/@beaver-ui/components/package.json | jq '.dependencies, .peerDependencies'
```

**Verify:** the scope you see matches what's already wired in. If it's
different — proceed to Step 1.3 to substitute. If matches `@tui-react`
— skip 1.3.

### Step 1.3 — Substitute the inner-DS scope (only if NOT `@tui-react`)

Code and prompts assume `@tui-react`. If your fork's inner-DS scope
differs, do a global substitution across these locations:

- `apps/beaver-runtime/src/index.ts` — runtime UMD re-exports.
- `apps/beaver-runtime/package.json` — dependencies.
- `apps/web/src/runtime/beaver-component.ts` — `ALLOWED_IMPORT_PREFIXES`.
- `apps/daemon/src/prompts/beaver-system.ts` — system prompt body.
- `packages/beaver-spec-extractor/src/sync.ts` — `DEFAULT_INNER_SCOPE`.
- `packages/beaver-spec-extractor/src/extract-tokens.ts` — JSDoc.
- `packages/beaver-spec-extractor/src/cli.ts` — help text default.
- `skills/beaver-prototype/SKILL.md` — example imports.
- `skills/beaver-prototype/assets/template.tsx` — seed imports.
- `design-systems/beaver/DESIGN.md` — descriptive text.
- `apps/beaver-runtime/README.md`, `README.md` — instruction text.

Mechanical substitution:

```bash
grep -rl '@tui-react' apps/ packages/ skills/ design-systems/ README.md apps/beaver-runtime/README.md \
  | xargs sed -i 's|@tui-react|@your-actual-scope|g'
```

**Do NOT touch** `LOCAL-AGENT-HANDOFF.md` or `REMOTE-FIX-QUEUE.md` —
those contain historical references and instructions about the
placeholder concept; rewriting them confuses future readers.

**Verify:** `grep -rn '@tui-react' apps/ packages/ skills/` returns
zero hits, and `grep -rn '@your-actual-scope' apps/ packages/ skills/`
returns hits in the locations listed above.

### Step 1.4 — Build the runtime UMD

```bash
pnpm beaver:build-runtime
```

Should produce `apps/beaver-runtime/dist/beaver.umd.js` (~5–15 MB) and
`beaver.css` (~500 KB), then copy them into
`apps/web/public/vendor/`.

**Verify:**

```bash
ls -lh apps/beaver-runtime/dist/beaver.umd.js apps/web/public/vendor/beaver.umd.js
```

Both should exist and be non-empty.

**If the build fails:** issues in `apps/beaver-runtime/src/index.ts`,
`vite.config.ts`, or the inner-DS substitution. Likely candidates:

- Vite cannot resolve a `@actual-scope/*` import (deps mismatch in
  `apps/beaver-runtime/package.json`).
- `react/jsx-runtime` re-emerges as external (we removed it; if it
  comes back, that's a regression — file a queue entry).
- A subpath under `@actual-scope/design-tokens` that the remote
  hardcoded as `colors`/`spacing`/etc. doesn't actually exist with
  those exact names.

File any of these as queue entries with the actual error output. Do
not "fix" by commenting out the failing import.

### Step 1.5 — Run spec extractor

```bash
pnpm beaver:sync
```

For first run, omit `--beaver` / `--inner` (so docs corpus is empty —
that's fine, components and tokens will still extract from
`node_modules`).

**Verify:**

```bash
jq '{
  components: (.components | length),
  byTier: ([.components[] | .tier] | group_by(.) | map({tier: .[0], count: length})),
  tokenGroups: (.tokenGroups | length)
}' skills/beaver-prototype/components.json

ls skills/beaver-prototype/specs/ | wc -l            # should match component count
ls skills/beaver-prototype/tokens/                    # should list per-group .json + index.json
```

Expected ranges (rough):

- `components` total: 800–1500 (depends on how many subcomponents the
  bundle exports).
- `byTier`: should have both `primary` and `fallback` rows; primary
  count > 0.
- `tokenGroups`: 4–8 (color, spacing, typography, animation, …).
- `specs/<Name>.json` count: equal to components total.

**v2.1 — what should be different from your last run:**

- Component count should be 800-1500 (was 112). Inner-DS components
  now reach `window.Beaver` because `apps/beaver-runtime/src/index.ts`
  has the `export * from '@tui-react/components'` line uncommented.
- Per-spec `props` should be non-empty for the majority of components.
  TS Compiler API now sees `react/index.d.ts` (added as a rootName);
  on remaining failures, an AST fallback walks the `.d.ts` directly.
- Token entries should have real values (`#xxxxxx`, numbers, etc.),
  not `"any"`. Token extraction now uses dynamic `import()` of the
  JS module — actual runtime values, not the erased `.d.ts` type.
- Spec/manifest field is `docSummary`, not `description` or
  `oneLineDescription`. Update your `jq` queries accordingly.

**Common rough edges if any of the above don't pan out** (file as
queue entries — don't attempt fixes):

- `pnpm beaver:sync done — 0 component specs, 0 token groups, 0 doc files`
  — JSDOM threw while loading the bundle. The error is now collected
  and printed in the thrown exception (REMOTE-FIX-QUEUE.md #1 fix).
  Capture verbatim. As a quick alternative try
  `pnpm beaver:sync -- --introspector playwright` after installing
  `playwright` and running `playwright install chromium`.
- A subset of specs still has empty `props: []` — the AST fallback
  also failed for those shapes. Run with
  `--debug-component <Name>` to see per-step diagnostics for one of
  the offending components and file the diagnostics.
- Token entries STILL contain `"value": "any"` for some entries — the
  fallback TS Compiler API path was used because dynamic `import()`
  failed. The error message in `errors[]` will say which package
  failed to import.
- Component count grew but still substantially below
  `Object.keys(window.Beaver)` count — the `name → package` resolver
  didn't find some sub-packages in node_modules. Capture which names
  landed in `@unknown`.

### Step 1.6 — Add docs corpus (requires source checkouts)

```bash
pnpm beaver:sync \
  --beaver /abs/path/to/beaver-ui-checkout \
  --inner  /abs/path/to/inner-ds-checkout
```

**Verify:**

```bash
ls skills/beaver-prototype/docs/                # should list package directories
find skills/beaver-prototype/docs -name '*.md' | wc -l   # >100 expected
```

Per-component docs are best-effort. Empty corpus on the first run is
not a blocker — the daemon's `beaver_search_docs` tool will simply
return zero results until the corpus is populated.

### Step 1.7 — Try running the daemon

```bash
pnpm --filter daemon dev
```

The daemon should start without errors related to the new beaver-tools
imports. The daemon won't be useful until you wire qwen-code
(Phase 0 below), but it should start.

**Verify:** daemon starts, listens on its usual port, and `tail -f` of
its stderr shows no exceptions about missing modules or unresolved
type imports.

**If it fails on type-check:** the most likely culprit is the
`@beaver-open-design/spec-extractor` workspace dep. Check that:

- `pnpm install` linked the workspace.
- `node_modules/@beaver-open-design/spec-extractor` exists and points
  at `packages/beaver-spec-extractor`.

If those are fine and types still fail to resolve — queue entry.

### Step 1.8 — Try the MCP server standalone

```bash
node ./apps/daemon/dist/cli.js beaver-mcp --skill-dir "$(pwd)/skills/beaver-prototype"
# or in dev:
pnpm --filter daemon exec node --import tsx ./src/cli.ts beaver-mcp \
  --skill-dir "$(pwd)/skills/beaver-prototype"
```

The server runs as a stdio MCP transport — it doesn't print anything
on stdout (that's the MCP channel). Test it via the MCP CLI inspector
or by piping a JSON-RPC request:

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | \
  node ./apps/daemon/dist/cli.js beaver-mcp --skill-dir "$(pwd)/skills/beaver-prototype"
```

Expected output: a JSON response listing the 6 tools.

**If it errors:** likely a wiring issue between `cli.ts` (dynamic
import) and `mcp-beaver-tools-server.ts`. Queue entry with the exact
output.

### Step 1.9 — End-to-end with qwen-code (after Phase 0 below)

After Phase 0 is done, you can drive the actual chat. Smoke tests live
in section 5 (Verification checklist).

---

## 2. Phase 0 — qwen-code fork integration

The MCP server is ready and follows the standard MCP protocol. What
remains is wiring it to the corp qwen-code fork.

### 2.1 Verify MCP support in qwen-code

Read the qwen-code fork's docs or source to confirm:

- It supports MCP servers via `--mcp <path>`, an `mcp.config.json`, or
  a similar config.
- It calls `tools/list` on startup and exposes the returned tools to
  the model.
- It calls `tools/call` with `{ name, arguments }` shape (standard
  MCP).
- It feeds tool outputs back into the conversation as `tool` role
  messages (standard).

**If yes:** add a config entry pointing at `od beaver-mcp` (with the
correct `--skill-dir` argument). Done.

**If no:** either:

(a) Patch the fork to support standard MCP. This is the preferred path
because it opens the door to other Open Design tools (`od mcp` for
project-aware reads).

(b) Adapt the daemon to expose tools via whatever native protocol the
fork uses. Re-implement the dispatch in
`apps/daemon/src/mcp-beaver-tools-server.ts`'s shape — same six tool
names and schemas, different transport. The shared pieces (`beaver-
tools.ts` and `BEAVER_TOOL_DESCRIPTORS`) stay protocol-neutral; only
the transport layer changes.

### 2.2 Without-yolo mode auto-confirm

In without-yolo, qwen-code asks for confirmation on actions like
write-file, run-command, etc. For our pipeline this is friction — the
agent needs to write the artifact file and retry on errors silently.

Find how the fork signals confirmation requests:

- Stdout JSON event with a known shape?
- A specific stderr line?
- A blocking prompt on stdin?

Wire the daemon's spawn code to auto-confirm any request originating
from inside an agent run. If the fork has no programmatic auto-confirm
mechanism, ask the maintainers to add a `--yes-everything` flag the
daemon can pass.

### 2.3 Remove non-qwen agent code

Per plan §5: delete from `apps/daemon/src/`:

- `claude-stream.ts`, `copilot-stream.ts`, `qoder-stream.ts`, any other
  per-CLI stream handlers.
- `codex-pets.ts`, `community-pets-sync.ts`, `claude-design-import.ts`.
- BYOK proxy logic (search `BYOK`, `proxyOpenAI`, similar).
- All branches in `agents.ts` that enumerate / detect non-qwen CLIs.
  Reduce to a single `AgentDef` for the corp qwen-code fork.

The composer in `system.ts` accepts an `agentId` it ignores; keep that
signature for now to minimize ripple.

This work is yours (the local agent's) — touching files all over
`agents.ts` and similar. No queue entries needed unless you find that
removing one of these breaks something the remote authored (e.g. an
import in `server.ts` that you can't easily get rid of).

---

## 3. Phase 5 — web auto-correction loop

The iframe now postMessages errors via three event types:
`od:beaver-runtime-ready`, `od:beaver-runtime-error`,
`od:beaver-runtime-rendered`. The parent must:

1. Subscribe to `message` events on the iframe.
2. Discriminate `od:beaver-runtime-error` events and **NOT show the
   user** the error UI. The chat preview pane keeps showing the
   "generating" indicator.
3. Form a correction prompt. Use `renderBeaverCorrectionPrompt` from
   `@open-design/contracts` to get the structured shape — same
   `[automated correction request]` prefix the discovery prompt's
   self-correction protocol references.
4. POST to the chat API as a synthetic user-turn (or whatever the chat
   API calls "auto-correction"). Mark it so it doesn't appear in the
   user-visible transcript; it's bookkeeping between web → daemon →
   agent.
5. When the next artifact arrives, replace the iframe's `srcdoc`. New
   render starts; same listener fires on the new iframe.
6. Cap retries at 5. After that, surface a soft message:
   "Не удалось собрать прототип. Сформулируйте запрос проще или
   попробуйте ещё раз." No stack traces.

**Files to touch (yours):**

- `apps/web/src/components/FileViewer.tsx` (or wherever the iframe is
  mounted) — message listener and retry counter.
- "Generating" UI state needs to support "still generating, attempt 2
  of 5" — informative without being scary.
- Chat client / SSE handler — a path for synthetic correction-turn
  POSTs distinguishable from real user turns.
- Daemon side: chat handler — accept `kind: 'auto-correction'` flag
  (or similar), treat the message as a user turn for the agent but
  suppress it from the transcript sent back to web.

The `[automated correction request]` text marker is what the discovery
layer's self-correction protocol references; using it lets the agent
recognize the turn.

---

## 4. Phase 1 — testing the spec extractor

(See Step 1.5 in the runbook for the bare-minimum check. This section
is what to do when issues come up.)

Likely rough edges, in probability order:

- **JSDOM bundle load throws.** Some Beaver/inner-DS modules may
  evaluate code on import that JSDOM doesn't support. Queue entry with
  the exception text. The remote may decide to (a) polyfill the missing
  API on the JSDOM window, (b) replace JSDOM with a Playwright shim,
  or (c) provide a different React-stub.

- **`name → package` resolution misses sub-packages.** The current
  approach reads `apps/beaver-runtime/package.json` for runtime deps.
  If sub-packages aren't directly listed (some monorepos hoist them),
  the resolver returns `@unknown` for those names. Queue entry with
  examples.

- **TS Compiler API returns synthetic types for utility types.** If a
  prop type comes out as `{}` because `Omit<X, Y>` resolved to an
  unrepresentable shape, capture the input type in the `.d.ts` and
  queue. The remote may add a fall-back to capture the textual
  representation directly.

- **Token extraction returns nothing.** If the inner-DS's
  design-tokens package wraps values in a function call or computed
  property, the `walkObjectType` in `extract-tokens.ts` may bottom
  out at "Generic". Queue entry — capture the type text and a sample
  of the raw .ts source. The remote will extend the walker.

- **Doc extraction picks up internal helpers.** The JSDoc scanner
  matches anything that looks like an exported PascalCase, including
  utility components. Not strictly an error, but a quality issue.
  Queue entry; the remote may add a filter.

---

## 5. `beaver_dry_run` runner

`apps/daemon/src/beaver-tools.ts` has `BeaverToolsContext.dryRun?` as
an optional injection point. The MCP server accepts a `dryRun` option
but the CLI entry doesn't pass one yet.

**Yours to author:**

1. A function that:
   - Loads `apps/beaver-runtime/dist/beaver.umd.js` once (cache the
     window-state in a JSDOM, or boot a headless Playwright tab on
     first call).
   - Receives TSX source.
   - Runs `rewriteBeaverImports` + `prepareReactComponentSource` (the
     same functions the iframe uses; they're exported from
     `apps/web/src/runtime/beaver-component.ts` —
     consider extracting them to a shared module if you don't want a
     web→daemon dependency).
   - Runs Babel transform with `presets: ['typescript', 'react']`.
   - Evaluates and mounts via `ReactDOM.createRoot(...).render()`.
   - Returns `{ ok: true }` or `{ ok: false, reason, message }`.

2. Pass it through `od beaver-mcp` startup. Add a `--dry-run-impl`
   flag accepting `jsdom` (in-process) or `playwright` (subprocess).

Without a wired dryRun, the iframe's runtime-error postMessage path
still catches errors at preview time — `dry_run` is the *fast*
pre-emit check, not the *correctness* gate. So this is an
optimization, not a blocker.

---

## 6. Phase 2 — kind classification (optional)

`pnpm beaver:classify` is referenced in the plan but not implemented.
Skeleton:

- Read the manifest.
- For each component with `kind: 'unknown'`, prepare a small payload:
  `{ name, package, docSummary, propNames }`.
- Call qwen-code through a minimal wrapper, asking for one of:
  `layout | input | feedback | overlay | data-display | navigation
  | typography | media | utility | unknown`.
- Write back into `components.json`.

Cost: ~$0.001 per component if the model is cheap; ~$1.50 for 1500
components. One-time per Beaver release.

Not required. The manifest works fine with all `kind: 'unknown'`. Defer
until other things are stable.

---

## 7. Verification checklist (declare v2 done)

Run through this entire list in order. Tick boxes as you go.

### Setup gates

- [ ] `pnpm install` succeeds; `@beaver-ui/components` is a real
      version (not `0.0.0-stub`).
- [ ] Inner-DS scope verified. If `@tui-react`, no substitution
      needed (already wired in v2.1). If different — Step 1.3
      substitution done; `grep -rn '@tui-react' apps/ packages/
      skills/` returns 0.
- [ ] `pnpm beaver:build-runtime` produces `beaver.umd.js` (>1 MB) and
      `beaver.css`, both copied to `apps/web/public/vendor/`.

### Spec extractor gates (post v2.1)

- [ ] `pnpm beaver:sync` finishes without errors.
- [ ] `components.json` has 800–1500 components, both `primary` and
      `fallback` tiers.
- [ ] **At least 60% of components have non-empty `props` arrays in
      their per-component spec files.** Run:
      `find skills/beaver-prototype/specs -name '*.json' -exec jq '.props | length' {} \; | awk '$1>0' | wc -l`
- [ ] **No token entry has `"value": "any"`.** Run:
      `jq '[.entries[] | select(.value == "any")] | length' skills/beaver-prototype/tokens/*.json | jq -s 'add'` → 0
- [ ] At least one component has non-null `docSummary` in either spec
      or manifest. With source checkouts (`--beaver`/`--inner`),
      coverage should be ≥ 50%.

### Daemon gates

- [ ] `pnpm --filter daemon dev` starts cleanly.
- [ ] `od beaver-mcp --skill-dir <path>` runs and responds to
      `tools/list` JSON-RPC with 6 tools.

### qwen-code integration gates

- [ ] qwen-code's MCP config points at `od beaver-mcp` and lists the
      6 tools on startup.
- [ ] Without-yolo confirmations are auto-handled by the daemon
      spawn code; agent runs without manual interaction.
- [ ] Non-qwen CLI code removed from `apps/daemon/src/`.

### Web auto-correction gates

- [ ] Iframe `od:beaver-runtime-error` events are captured by the
      parent and **never** displayed to the user.
- [ ] Auto-correction loop sends a synthetic chat turn with the
      `[automated correction request]` prefix.
- [ ] Retry-limit of 5 enforced; after the limit, soft fallback message
      appears.
- [ ] User sees only successfully rendered iframes (visually verify
      with a deliberately broken artifact — e.g. force a missing
      import — and confirm no error is visible during retries).

### Smoke tests

For each test below, the user should see a single successful preview
or a discovery question. The user should NOT see error banners at any
point.

- [ ] **Test A — simple form.** Prompt: "форма входа с email и
      паролем". Expected: turn-1 discovery question (1–2 items),
      turn-2 vocalization, tool calls (search_components,
      get_component_spec for at least 3 names), `dry_run`, artifact
      emission, render OK on first attempt.

- [ ] **Test B — complex screen.** Prompt: "back-office дашборд по
      заявкам клиентов: header + sidenav + filter-table". Expected:
      multi-question discovery, vocalization, TodoWrite with 5+ items,
      multi-tool turn, dry_run, render OK.

- [ ] **Test C — unsupported component.** Prompt: "график продаж по
      месяцам". Expected: agent searches via tools, finds nothing,
      tells the user "графиков нет в DS, предлагаю Box-плейсхолдер
      или явное разрешение на кастом". Does NOT emit SVG.

- [ ] **Test D — token override.** Prompt: "карточка с padding 13px и
      розовой рамкой". Expected: agent searches tokens, picks closest
      values, refuses to hardcode. If the user insists on exact 13px,
      the agent explains the policy and proposes the nearest token.

- [ ] **Test E — auto-correction loop.** Provide a deliberately
      incomplete artifact (e.g. via debug-injected response) where
      the LLM forgets a sub-component import. Expected: iframe
      throws, error not visible to user, daemon receives the
      correction request, agent re-emits with the import added,
      second iframe renders successfully. The transcript visible to
      the user shows only one artifact (the fixed one).

- [ ] **Test F — retry exhaustion.** Force 5 consecutive failed
      artifacts. Expected: soft message appears
      ("упростите запрос…"), no traceback shown, no white screen of
      death.

### Manifest health

- [ ] System prompt size, end-to-end: < 50 KB. Verify by adding a
      temporary `console.log(prompt.length)` in
      `composeDaemonSystemPrompt` and watching daemon stderr on the
      first turn of any project.

### REMOTE-FIX-QUEUE

- [ ] All issues encountered during the runbook are recorded in
      `REMOTE-FIX-QUEUE.md` with full repro details. Workarounds (if
      any) are tagged in source with `TEMP-WORKAROUND #<n>`.

---

## 8. What's out of scope for this round

Don't pursue these unless explicitly asked:

- UMD bundle size optimization (currently 8.6 MB upstream; may grow
  with full inner-DS). Plan §8.
- Visual regression tests on rendered prototypes.
- Schema validation of `components.json` shape (Zod / JSON Schema). The
  extractor controls the shape; not needed.
- Caching of bundle introspection by content hash. If `beaver:sync`
  becomes slow enough to matter, then yes — but only then.
- Full text-search index of the docs corpus (currently linear scan).
  At ~1500 components × ~5 KB / doc, the linear search is fast enough.

---

## 9. Where to file what

| Type of question / problem | Where |
|---|---|
| Issue in remote-authored code | `REMOTE-FIX-QUEUE.md` |
| Question for the remote about architectural intent | `REMOTE-FIX-QUEUE.md` (notes section) or new file `REMOTE-QUESTIONS.md` if more than ~5 |
| Bug in your own code | wherever feels natural — your repo |
| Question about Beaver / inner-DS internals | not for the remote (NDA); ask team. |
| Question about qwen-code internals | not for the remote (NDA); ask team. |

---

## 10. When you're done

1. All checkboxes in §7 are ticked.
2. `REMOTE-FIX-QUEUE.md` is up to date.
3. Push the branch, summarize what you completed and what's outstanding
   (referencing queue entries by number) in the PR description.

The remote will review the queue and ship fixes as a follow-up PR
before declaring v2 fully landed.
