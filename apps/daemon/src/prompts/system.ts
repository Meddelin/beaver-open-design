/**
 * Prompt composer (beaver-open-design fork).
 *
 * The upstream open-design composer stacks ~7 layers (discovery, official
 * designer charter, active design system, craft references, active skill,
 * project metadata, deck/media frameworks) and chooses among 31 skills and
 * 70+ design systems. This fork has exactly one of each: the
 * `beaver-prototype` skill and the Beaver UI design system. Everything is
 * fixed — pickers in the UI default to these and there is nothing else to
 * select.
 *
 * The composer therefore reduces to:
 *   1. The Beaver designer base prompt (./beaver-system.ts).
 *   2. The active skill body (skills/beaver-prototype/SKILL.md), if the
 *      caller passed one. The daemon resolves it from disk.
 *   3. The auto-generated Beaver manifest block — components.json plus the
 *      tokens reference — pinned LAST so it always wins precedence.
 *
 * `ComposeInput` keeps its old shape so call sites in the daemon don't all
 * have to be touched at once. Fields the upstream composer used (deck mode,
 * media kind, design-system body, codex imagegen override, prompt
 * templates) are accepted but ignored.
 */
import {
  BEAVER_DESIGNER_PROMPT,
  renderBeaverAllowListBlock,
} from './beaver-system.js';

type ProjectMetadata = {
  kind?: string;
  intent?: string | null;
  fidelity?: string | null;
  speakerNotes?: boolean | null;
  animations?: boolean | null;
  templateId?: string | null;
  templateLabel?: string | null;
  inspirationDesignSystemIds?: string[];
  imageModel?: string | null;
  imageAspect?: string | null;
  imageStyle?: string | null;
  videoModel?: string | null;
  videoLength?: number | null;
  videoAspect?: string | null;
  audioKind?: string | null;
  audioModel?: string | null;
  audioDuration?: number | null;
  voice?: string | null;
  promptTemplate?: unknown;
};
type ProjectTemplate = {
  name: string;
  description?: string | null;
  files: Array<{ name: string; content: string }>;
};

export const BASE_SYSTEM_PROMPT = BEAVER_DESIGNER_PROMPT;

export interface ComposeInput {
  agentId?: string | null | undefined;
  includeCodexImagegenOverride?: boolean | undefined;
  skillBody?: string | undefined;
  skillName?: string | undefined;
  skillMode?:
    | 'prototype'
    | 'deck'
    | 'template'
    | 'design-system'
    | 'image'
    | 'video'
    | 'audio'
    | undefined;
  designSystemBody?: string | undefined;
  designSystemTitle?: string | undefined;
  craftBody?: string | undefined;
  craftSections?: string[] | undefined;
  metadata?: ProjectMetadata | undefined;
  template?: ProjectTemplate | undefined;
  /**
   * Optional override for the manifest body. The daemon usually reads
   * `skills/beaver-prototype/components.json` from disk and passes it
   * here. Tests / fixtures may pass a synthetic value. When omitted, an
   * empty allow-list is rendered (which is a hard fail signal — no
   * components are available).
   */
  beaverComponentsJson?: string | undefined;
  beaverTokensMarkdown?: string | undefined;
}

export function composeSystemPrompt(input: ComposeInput): string {
  const parts: string[] = [BASE_SYSTEM_PROMPT];

  if (input.skillBody && input.skillBody.trim().length > 0) {
    const skillName = input.skillName ?? 'beaver-prototype';
    parts.push(
      `\n\n---\n\n## Active skill — ${skillName}\n\nFollow this skill's workflow exactly. **Pre-flight (do this before any other tool):** Read \`skills/beaver-prototype/assets/template.tsx\`, \`skills/beaver-prototype/components.json\`, and \`skills/beaver-prototype/references/index.md\`. The seed defines your starting point; the manifest is the closed set of everything that exists; the index tells you which per-component spec to read for each component you place.\n\n${input.skillBody.trim()}`,
    );
  }

  parts.push(
    renderBeaverAllowListBlock({
      componentsJson: input.beaverComponentsJson ?? '{}',
      tokensMarkdown:
        input.beaverTokensMarkdown ??
        '_No tokens captured. Run `pnpm beaver:sync --beaver <path> --inner <path>` first._',
    }),
  );

  return parts.join('');
}

// The codex imagegen / media branches were removed when the fork dropped
// every skill except `beaver-prototype`. These shims keep callers in the
// daemon compiling without touching their import sites; they all return
// empty / no-op values now.

export function resolveCodexImagegenModelId(
  _metadata: ProjectMetadata | undefined,
): string {
  return '';
}

export function shouldRenderCodexImagegenOverride(
  _agentId: string | null | undefined,
  _metadata: ProjectMetadata | undefined,
): boolean {
  return false;
}

export function renderCodexImagegenOverride(
  _agentId: string | null | undefined,
  _metadata: ProjectMetadata | undefined,
): string {
  return '';
}
