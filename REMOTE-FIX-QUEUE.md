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
