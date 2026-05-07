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

_(none yet — local agent fills in as it works through the runbook in
LOCAL-AGENT-HANDOFF.md)_
