/**
 * Prompt composer (beaver-open-design fork, v2).
 *
 * The composer stacks four layers, ordered by precedence (highest first):
 *
 *   1. Discovery + flow philosophy (./beaver-discovery.ts) — turn-1
 *      questions, vocalization, TodoWrite cadence, mandatory tool usage,
 *      pre-emit dry_run self-check, self-correction protocol.
 *   2. Designer base (./beaver-system.ts) — identity, the six hard rules of
 *      artifact production, artifact format, design / content / tone
 *      guidelines.
 *   3. Active skill body (skills/beaver-prototype/SKILL.md) — composition
 *      workflow specific to "Beaver UI prototype" use case.
 *   4. Lean component index — names of all components grouped by package,
 *      with package-level counts. Approx 10–30 KB. NOT the full
 *      components.json (which used to be 500 KB and ate the entire context
 *      budget). Full per-component specs are pulled lazily by the model
 *      via beaver_get_component_spec(name).
 *   5. Tools manifesto — short reminder that DS context is fetched via
 *      tools, not from the prompt body.
 *
 * The composer no longer injects the full components.json or token tables.
 * Those are reachable through tool calls; the prompt just teaches the model
 * which tools to use.
 *
 * `ComposeInput` keeps its old shape so existing call sites in the daemon
 * (server.ts) compile. Fields that the upstream open-design composer used
 * (deck mode, media kind, design-system body, codex imagegen override,
 * prompt templates) are accepted but ignored — the fork has only one
 * surface.
 */
import { BEAVER_DESIGNER_PROMPT } from './beaver-system.js';
import { BEAVER_DISCOVERY_AND_FLOW } from './beaver-discovery.js';

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

/**
 * Parsed component manifest entry. The full `components.json` may carry
 * more fields (full props, examples, referencedTypes); the composer only
 * reads what it needs for the lean index.
 */
export interface ManifestEntry {
  name: string;
  package: string;
  /** "primary" for @beaver-ui/*, "fallback" for inner-DS. */
  tier?: 'primary' | 'fallback';
  /** Optional one-line description; if present, may be shown in the index. */
  docSummary?: string;
}

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
   * Raw text of `skills/beaver-prototype/components.json`. The composer
   * parses it to render the lean component index — it does NOT inline the
   * raw JSON into the prompt. If parsing fails or the file is missing, the
   * index falls back to a "manifest not generated yet" stub.
   */
  beaverComponentsJson?: string | undefined;
  /**
   * Deprecated. Tokens are no longer injected as Markdown; the model fetches
   * them lazily via beaver_list_token_groups + beaver_get_tokens. Kept in
   * the type only so old call sites compile.
   */
  beaverTokensMarkdown?: string | undefined;
}

export function composeSystemPrompt(input: ComposeInput): string {
  const parts: string[] = [
    BEAVER_DISCOVERY_AND_FLOW,
    '\n\n---\n\n',
    BEAVER_DESIGNER_PROMPT,
  ];

  if (input.skillBody && input.skillBody.trim().length > 0) {
    const skillName = input.skillName ?? 'beaver-prototype';
    parts.push(
      `\n\n---\n\n## Active skill — ${skillName}\n\nFollow this skill's workflow exactly. The skill is the *what* (composition patterns); the rules above are the *how* (process and constraints).\n\n${input.skillBody.trim()}`,
    );
  }

  parts.push(renderComponentIndex(input.beaverComponentsJson));
  parts.push(renderToolsManifesto());

  return parts.join('');
}

/**
 * Render the lean component index — names grouped by package, with
 * Beaver-primary section first and inner-DS-fallback section second. This
 * replaces the upstream `renderBeaverAllowListBlock` which inlined the
 * entire 500 KB components.json.
 *
 * If the manifest is missing or unparseable, render a stub that tells the
 * model to fetch components via tools instead.
 */
export function renderComponentIndex(componentsJsonRaw: string | undefined): string {
  const entries = parseManifest(componentsJsonRaw);

  if (entries.length === 0) {
    return `

---

## DS surface

The component manifest has not been generated yet (or failed to parse). Use the tools to discover what exists:

- \`beaver_search_components(query)\` — search by name or description.
- \`beaver_get_component_spec(name)\` — full props + examples for a name.

Do not invent component names; verify each one through tools before use.
`;
  }

  // Group by package, then split by tier.
  const byPackage = new Map<string, { tier: 'primary' | 'fallback' | 'unknown'; names: string[] }>();
  for (const entry of entries) {
    const tier = (entry.tier ?? inferTier(entry.package)) ?? 'unknown';
    const cur = byPackage.get(entry.package) ?? { tier, names: [] };
    cur.names.push(entry.name);
    byPackage.set(entry.package, cur);
  }

  const primary: string[] = [];
  const fallback: string[] = [];
  const sortedPackages = [...byPackage.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  );
  for (const [pkg, info] of sortedPackages) {
    info.names.sort();
    const line = `- \`${pkg}\` (${info.names.length}): ${info.names.join(', ')}`;
    if (info.tier === 'fallback') fallback.push(line);
    else primary.push(line);
  }

  return `

---

## DS surface — names only

Beaver UI is the primary surface. The inner DS Beaver consumes is a fallback — use it only when no Beaver component fits, even by composition.

For full props / examples / referenced types of any name below, call \`beaver_get_component_spec(name)\`. Never guess props.

### Beaver (primary — pick from here first)

${primary.length > 0 ? primary.join('\n') : '_(no Beaver packages in manifest — check beaver:sync ran successfully)_'}

### Inner DS (fallback — only when Beaver does not have an equivalent)

${fallback.length > 0 ? fallback.join('\n') : '_(no inner-DS packages in manifest)_'}

Tokens live exclusively in the inner DS. Discover them via \`beaver_list_token_groups()\` and fetch values via \`beaver_get_tokens(group)\`.
`;
}

function renderToolsManifesto(): string {
  return `

---

## Tool reference

You have these tools for design-system context. Use them — do not work from prompt content alone.

- \`beaver_search_components(query, limit?)\` — fuzzy search across names and descriptions. Beaver components rank above inner-DS at equal relevance. Returns \`{ name, package, tier, kind, docSummary }[]\`.
- \`beaver_get_component_spec(name)\` — full spec for one component: props (types, required, defaults, enum values), examples, referencedTypes (cross-package).
- \`beaver_list_token_groups()\` — short list of token groups (color, spacing, typography, animation, …) with sample keys.
- \`beaver_get_tokens(group)\` — flat \`{ path: value }\` for a token group.
- \`beaver_search_docs(query)\` — search across DS documentation (MDX, JSDoc, READMEs). Use when component spec is not enough — for usage patterns, edge cases, "how to use X with Y".
- \`beaver_dry_run(source)\` — compile and mount the TSX in a headless runtime. Returns \`{ ok: true }\` or \`{ ok: false, error }\`. **Mandatory before every \`<artifact>\` emission.**

Tools are how you stay accurate. The prompt is intentionally short — it does not contain full props or token values. That is by design.
`;
}

function parseManifest(raw: string | undefined): ManifestEntry[] {
  if (!raw || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return [];
    const components = (parsed as { components?: unknown }).components;
    if (!Array.isArray(components)) return [];
    const out: ManifestEntry[] = [];
    for (const item of components) {
      if (!item || typeof item !== 'object') continue;
      const name = (item as { name?: unknown }).name;
      const pkg = (item as { package?: unknown }).package;
      const tierRaw = (item as { tier?: unknown }).tier;
      const desc = (item as { docSummary?: unknown }).docSummary;
      if (typeof name !== 'string' || typeof pkg !== 'string') continue;
      const entry: ManifestEntry = { name, package: pkg };
      if (tierRaw === 'primary' || tierRaw === 'fallback') entry.tier = tierRaw;
      if (typeof desc === 'string') entry.docSummary = desc;
      out.push(entry);
    }
    return out;
  } catch {
    return [];
  }
}

function inferTier(pkg: string): 'primary' | 'fallback' | undefined {
  if (pkg.startsWith('@beaver-ui/')) return 'primary';
  if (pkg.startsWith('@')) return 'fallback';
  return undefined;
}

// Codex imagegen / media branches (upstream open-design feature) were
// removed when the fork dropped every skill except `beaver-prototype` and
// every CLI except qwen-code. These shims exist so any leftover call sites
// in the daemon compile; they all return empty / no-op values.

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
