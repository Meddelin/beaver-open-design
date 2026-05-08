# Remote fix queue

This file is where the **local agent** records issues it finds in code
the **remote (Claude) authored** during v2. The remote will work through
this list later and apply proper fixes consistent with the architectural
intent.

> **Policy:** the local agent does NOT silently patch remote-authored
> code. Every issue gets a structured entry below. If a workaround is
> required to unblock progress, the local agent may add a TEMP-WORKAROUND
> tagged with the issue number, but the issue stays in this queue until
> the remote resolves it.

## Authorship of files (so we know what's "remote-authored")

Remote-authored in v2 (commits `49ddc54`, `2bb095d`, `7b83bb3`):

```
apps/daemon/src/prompts/beaver-discovery.ts
apps/daemon/src/prompts/beaver-system.ts
apps/daemon/src/prompts/system.ts            # rewritten
apps/daemon/src/server.ts                    # diff: composeDaemonSystemPrompt section
apps/daemon/src/beaver-tools.ts
apps/daemon/src/mcp-beaver-tools-server.ts
apps/daemon/src/cli.ts                       # diff: `od beaver-mcp` block
apps/daemon/package.json                     # diff: workspace dep added
apps/web/src/runtime/beaver-component.ts     # rewritten
packages/contracts/src/beaver-validator.ts
packages/contracts/src/index.ts              # diff: re-export
packages/beaver-spec-extractor/src/types.ts
packages/beaver-spec-extractor/src/introspect-bundle.ts
packages/beaver-spec-extractor/src/extract-props.ts
packages/beaver-spec-extractor/src/extract-tokens.ts
packages/beaver-spec-extractor/src/extract-docs.ts
packages/beaver-spec-extractor/src/sync.ts
packages/beaver-spec-extractor/src/cli.ts
packages/beaver-spec-extractor/src/index.ts
packages/beaver-spec-extractor/package.json
skills/beaver-prototype/SKILL.md             # rewritten
LOCAL-AGENT-HANDOFF.md
```

For everything else, the local agent owns the code and may fix as it
sees fit. (The web auto-correction loop in `apps/web/src/...` for
example — that's local work; fix freely.)

## Format of an entry

```
## #<number> — <one-line title>

**File:** `path/to/file.ts`
**Line(s):** approximate
**Symptom:** what was observed (error message, wrong output, runtime
crash, type-check failure).
**Reproduction:**
  - exact command run, e.g. `pnpm beaver:sync`
  - relevant input state (which Beaver version, did `beaver-runtime`
    build, etc.)
**Severity:**
  - blocker — cannot progress without a fix or workaround
  - degrading — feature works partially / for some inputs
  - cosmetic — no functional impact
**Workaround applied (if any):** describe + reference TEMP-WORKAROUND tag
in source.
**Notes for the remote:** anything that helps the remote understand the
context — what the local agent suspects, what the local agent ruled out,
what the local agent tried that did not help.
```

## Entries

### #1 — JSDOM bundle introspection returns empty `window.Beaver`

**File:** `packages/beaver-spec-extractor/src/introspect-bundle.ts`
**Symptom:** `pnpm beaver:sync` completes with `0 component specs`. JSDOM loads the UMD bundle, `window.Beaver = {}` is assigned but `Object.keys(window.Beaver).length === 0`.
**Severity:** blocker (extractor produces nothing)
**Workaround applied:** none — local agent reported and waited.
**Notes for the remote:** bundle structure looked correct, manual test confirmed `window.Beaver.keys: []`. Local agent suspected (a) React stub incomplete, (b) JSDOM script execution context issue, or (c) missing globals like `ResizeObserver`.

**Status: RESOLVED** in commit fixing this queue. Three changes:

1. **Errors are no longer silently suppressed.** The previous code had
   `virtualConsole.on('error', () => {})` and
   `virtualConsole.on('jsdomError', () => {})` — which is the root cause
   of the symptom. The bundle was throwing during init, the throw was
   caught by JSDOM, and our code muted the error then reported "empty
   bundle". Now errors are *collected* into an array and become part of
   the thrown exception when `window.Beaver` ends up empty. The error
   message tells the local agent which init step failed.

2. **React/ReactDOM/jsx-runtime stubs expanded** to cover what React 18
   actually ships and what DS components commonly call at module-init:
   `cloneElement`, `isValidElement`, `Children`, `version`, `Suspense`,
   `lazy`, `Profiler`, `StrictMode`, `useTransition`, `useDeferredValue`,
   `useSyncExternalStore`, `useInsertionEffect`,
   `__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED` (for libraries
   that probe internals). `forwardRef`/`memo`/`lazy` now return objects
   tagged with the right `$$typeof` symbols. `useState` initializes from
   the function form. `useContext` returns `_currentValue`.

3. **DOM polyfills installed on the JSDOM window before script run**:
   `ResizeObserver`, `IntersectionObserver`, `matchMedia`,
   `requestAnimationFrame`/`cancelAnimationFrame`, `queueMicrotask`,
   `CSS.supports`, `process.env.NODE_ENV='production'`. These cover the
   common eager-init paths we know DS components walk on first load.

4. **Optional Playwright introspector** for cases JSDOM stubs still
   can't satisfy. Activate via `--introspector playwright`. Loads the
   bundle in real headless Chromium; same return shape so the rest of
   the pipeline doesn't care which was used. Requires
   `pnpm add -D -w playwright && pnpm exec playwright install chromium`
   one-time, otherwise dynamic-import throws a clear "install
   playwright" message.

If the JSDOM path *still* returns empty after this — the thrown error
will now include the actual exception(s) the bundle raised. Add a new
queue entry with that text.

---

### #2 — TypeScript 5.6 API: `getApparentProperties` is a Type method, not a TypeChecker method

**File:** `packages/beaver-spec-extractor/src/extract-tokens.ts:150` (and `extract-props.ts:355`)
**Symptom:** `TypeError: checker.getApparentProperties is not a function`.
**Severity:** blocker (token extraction crashes; props extraction crashes when reached)
**Workaround applied:** local agent changed `extract-tokens.ts:150` to `getPropertiesOfType(type)`. Tagged inline.
**Notes for the remote:** simple API mistake on remote's part — the method exists on `Type`, not on `TypeChecker`.

**Status: RESOLVED** as permanent fix in two files (`extract-tokens.ts`
and `extract-props.ts`, both call sites). The local agent's workaround
in `extract-tokens.ts` is now landed as the canonical implementation —
no TEMP-WORKAROUND tag needed anymore. The same fix applied to
`extract-props.ts` where I made the identical mistake.

`getPropertiesOfType` returns the declared properties; for our use case
(walking object types to collect props/tokens) this is the right call.
The `apparent` distinction matters when types have intersection
modifications, but we're not relying on those resolutions.

---

### #3 — `@inner-ds` placeholder substitution

**Files:** multiple — see Step 1.3 in LOCAL-AGENT-HANDOFF.md.
**Symptom:** code references `@inner-ds` placeholder instead of the actual scope.
**Severity:** non-issue — explicitly called out in handoff doc as mechanical substitution the local agent may perform without queue entry.
**Resolution:** local agent did the substitution. Filed for tracking only.

**Status: NO-ACTION** — this was always expected work and not a defect
in remote-authored code.

---

### #4 — TS Compiler API returns empty props arrays for all components

**File:** `packages/beaver-spec-extractor/src/extract-props.ts`
**Symptom:** All 115 component spec files have `"props": []`. Example from `specs/Button.json`:
```json
{"name":"Button","package":"@beaver-ui/button","tier":"primary","kind":"unknown","props":[],"docSummary":null}
```
**Reproduction:**
  - Run `pnpm beaver:sync` with Beaver UI 0.244.0
  - Check any spec file: `cat skills/beaver-prototype/specs/Button.json`
  - All show empty props arrays
**Severity:** blocker — LLM cannot know which props are available for each component, making the spec extractor useless for artifact generation
**Workaround applied:** none
**Notes for the remote:** The TS Compiler API integration in `extract-props.ts` is not resolving prop types correctly. Likely causes:
  - The type walker is not descending into React component prop types correctly
  - The resolver is hitting utility types (like `Omit<>`, `ComponentProps<>`) and returning empty
  - The `.d.ts` file paths being resolved may not match the actual published structure
Check `extract-props.ts` around lines 50-150 where the type walking happens. Compare against working implementations like `react-docgen-typescript`.

**Status: RESOLVED.** Root cause: `ts.createProgram({ rootNames: [dtsPath] })` was created with the package's `.d.ts` as the only root file. References to `react` (`ForwardRefExoticComponent`, `FC`) in that file therefore could not be resolved by the checker — `getCallSignatures()` returned empty, `apparentType.typeArguments` was empty, props extraction returned empty. The same global cause affected all 115 components.

Fixes:

1. Resolve `react/index.d.ts` (and `react-dom`, `@types/react`) up front, add as additional `rootNames` to every per-package program. Adds `types: ['react', 'react-dom']` and `baseUrl: nodeModulesDir` to compiler options for pnpm-symlink resolution.
2. AST fallback. When checker still returns empty after the React fix, parse the `.d.ts` text directly via TS AST: find the exported declaration with the requested name, walk its type node, unwrap `ForwardRefExoticComponent<RefAttributes & ButtonProps>` / `FC<X>` / `MemoExoticComponent<X>`, resolve named refs to local interface declarations, walk members. Less complete than checker (won't follow cross-file aliases) but works in degraded environments.
3. New CLI flag `--debug-component <Name>` for per-step diagnostics (symbol type after each unwrap, call-signature count, apparent-args count, AST-fallback verdict). The local agent now has a tool for diagnosing similar regressions in the future.

---

### #5 — Token extractor returns `"value": "any"` instead of actual token values

**File:** `packages/beaver-spec-extractor/src/extract-tokens.ts`
**Symptom:** Token group files contain entries like:
```json
{"path":"designTokens.color","value":"any"}
```
Instead of actual token values (e.g., `#ffffff`, `8px`, etc.)
**Reproduction:**
  - Run `pnpm beaver:sync`
  - Check `skills/beaver-prototype/tokens/designTokens.json`
  - All entries have `"value": "any"`
**Severity:** blocker — LLM cannot use tokens for styling without actual values. The whole point of token extraction is to provide concrete values the agent can reference.
**Workaround applied:** none
**Notes for the remote:** The `walkObjectType` function in `extract-tokens.ts` is bottoming out at unresolved types. The TS Compiler API is returning type objects that aren't being walked correctly. For design tokens, we need to:
  - Resolve the actual literal values (string, number) from the type
  - Handle nested object structures (e.g., `designTokens.color.background.primary`)
  - Handle cases where tokens are re-exported from other packages
Check how the walker handles literal types vs generic types.

**Status: RESOLVED.** Root cause: inner-DS publishes `export const designTokens: any` (or similar erased typing). `.d.ts` cannot recover literal values that the publisher's tsc erased — `typeToString(any) === "any"`, every entry bottoms out at the fallback string literal `"any"`.

Fix: switch primary path from TS Compiler API to **dynamic `import()` of the JS module**. The JS file always has the literal values regardless of how the .d.ts looks. `extractTokensViaRuntime` tries the package-name import first (honours the package's `exports` map and conditions); on failure, falls back to direct file-URL import via `findRuntimeEntryFile` (probes `module`, `main`, `exports['.']`, then common build-output paths). The TS Compiler API path is preserved as a last-resort fallback when dynamic import is blocked (rare: native add-ons, missing main, ESM/CJS mismatch).

`walkRuntimeObject` recursively descends nested objects and produces flat `path → value` entries with primitive values intact (real hex codes, real numbers). It special-cases small "leaf objects" with ≤4 primitive children (typical token shape `{ value: '#fff', meta: ... }`) so they appear as one entry instead of being flattened into separate paths.

---

### #6 — Component count substantially lower than expected (112 vs 800-1500)

**File:** `packages/beaver-spec-extractor/src/introspect-bundle.ts`
**Symptom:** Only 112 components extracted from the bundle. Expected range per handoff doc: 800-1500 components.
**Reproduction:**
  - Run `pnpm beaver:sync`
  - Check `jq '.components | length' skills/beaver-prototype/components.json` → returns 112
  - Compare with `Object.keys(window.Beaver).length` from bundle introspection
**Severity:** degrading — many components are missing from the manifest, so the LLM won't find them via `beaver_search_components`
**Workaround applied:** none
**Notes for the remote:** The `name → package` resolver in `introspect-bundle.ts` may be missing:
  - Sub-components (e.g., `HeaderTitle`, `HeaderSegments` from `@beaver-ui/header`)
  - Components that are re-exported through barrel exports
  - Components whose names don't match the expected pattern
Check the logic that maps `window.Beaver` keys back to their source packages. The resolver may be filtering out valid components.

**Status: RESOLVED.** Root cause was simpler than suspected — the resolver was fine. `apps/beaver-runtime/src/index.ts` lines 60–82 had the inner-DS re-exports **commented out** as placeholders. The local agent's Step 1.3 substitution replaced `@<inner-ds>` in some files but didn't uncomment the `export * from '@<inner-ds>/components'` line in `index.ts`. As a result, `window.Beaver` only contained Beaver-tier components (~112), inner-DS was absent.

Fix: uncomment and substitute. `index.ts` now does `export * from '@tui-react/components'` plus `import * as designTokens from '@tui-react/design-tokens'; export const tokens = { ...designTokens };`. The placeholder fallback `export const tokens: Record<string, Record<string, unknown>> = {}` was removed. Added matching deps to `apps/beaver-runtime/package.json`.

Bonus: `introspect-bundle.ts` now prints a stderr warning when a small component count (< 200) is paired with a high runtime-deps count (≥ 20). Saves the next operator from chasing the same false lead.

---

### #7 — Component specs lack documentation/descriptions

**File:** `packages/beaver-spec-extractor/src/extract-props.ts`, `packages/beaver-spec-extractor/src/extract-docs.ts`
**Symptom:** Component specs have `"docSummary": null` for all components. No JSDoc descriptions are being captured.
**Reproduction:**
  - Run `pnpm beaver:sync`
  - Check any spec: `jq '.docSummary' skills/beaver-prototype/specs/Button.json` → `null`
**Severity:** degrading — LLM has no natural language description of what each component does, only the (currently empty) props list
**Workaround applied:** none
**Notes for the remote:** Documentation should be extracted from:
  1. JSDoc comments in the `.d.ts` files (check if they're being read)
  2. MDX stories files from the `beaver-ui` repo source
  3. Auto-generated documentation from the `auto-doc` tool in the Beaver repo
The `extract-docs.ts` file exists but isn't being called or isn't finding sources. The `--beaver` and `--inner` flags are required for docs corpus but should also populate `docSummary` in per-component specs. Consider:
  - Adding a `--docs` flag that points to Beaver UI source checkout
  - Parsing stories files (`.stories.tsx`, `.stories.mdx`) for component descriptions
  - Extracting JSDoc from the published `.d.ts` files

**Status: RESOLVED** (with caveats). Two issues conflated under one ticket:

1. **Field name mismatch.** The remote-authored type used `description` while the local agent queried `.docSummary`. Renamed `ComponentSpec.description` → `docSummary` and `ManifestEntry.oneLineDescription` → `docSummary` for consistency. Same field name in both places now. Updated `beaver-tools.ts`, `prompts/system.ts`, `LOCAL-AGENT-HANDOFF.md` to match.

2. **JSDoc not in `.d.ts`.** Fundamentally a publisher choice — many DS publishers strip JSDoc from emitted `.d.ts`. The fix is to mine the source corpus (MDX, READMEs, JSDoc on source `.tsx`) when `--beaver`/`--inner` are passed, and use that for `docSummary`. Implemented as `hydrateDocSummariesFromDocs` in `sync.ts`: after `extract-docs` writes per-component .md files, the function pulls the first paragraph (skipping frontmatter, headings, "Package:" metadata) and assigns it to specs whose `docSummary` is still empty. Truncates to 240 chars.

After this, running `pnpm beaver:sync --beaver <path> --inner <path>` should populate `docSummary` for the majority of components — coverage depends on how complete the source-side documentation is. Without source checkouts, `docSummary` is populated only from JSDoc that the publisher preserved in `.d.ts`.

---

### #8 — MCP server `tools/list` returns empty response

**File:** `apps/daemon/src/mcp-beaver-tools-server.ts`, `apps/daemon/src/cli.ts`
**Symptom:** Running the MCP server and piping `tools/list` request returns empty output (no JSON response):
```bash
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | node apps/daemon/dist/cli.js beaver-mcp --skill-dir ./skills/beaver-prototype
# → no output
```
**Reproduction:**
  - Build daemon: `pnpm --filter daemon build`
  - Run: `node apps/daemon/dist/cli.js beaver-mcp --skill-dir ./skills/beaver-prototype < <(echo '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}')`
**Severity:** degrading — MCP server starts but doesn't respond to standard MCP protocol requests
**Workaround applied:** none
**Notes for the remote:** The server uses `StdioServerTransport` which should write JSON-RPC responses to stdout. Possible issues:
  - The `server.connect()` call may not be flushing responses before exit
  - The transport may need explicit flushing
  - Error handling may be swallowing exceptions silently
Test with explicit `process.stdout.write()` after `server.connect()` to verify the response is being generated.

**Status: RESOLVED.** Root cause: the remote-authored `cli.ts` had `process.exit(0)` immediately after `await startBeaverToolsMcpServer()`. When stdout is piped (not a TTY), Node fully buffers it; `process.exit(0)` does NOT wait for the buffer to drain. The MCP response was generated correctly by the SDK and written to stdout's internal buffer, then truncated by the explicit exit before reaching the pipe.

Fix: replace `process.exit(0)` with `process.stdout.end(() => process.exit(0))`. The `end()` callback fires after all buffered data has been flushed to the underlying pipe. Comment in code documents the rationale (so future readers don't "simplify" it back to a bare exit).

The same buffering trap is the reason this only manifested in the one-shot pipe smoke test. In long-lived parent (qwen-code spawning the server and holding stdin open), the SDK's stdout writes happen on a live transport and are flushed naturally — no truncation. So this fix is for diagnostic / smoke-test usage; production flows weren't affected, but the smoke test is what people run first.
