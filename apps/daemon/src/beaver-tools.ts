/**
 * Beaver design-system tools for the agent.
 *
 * Six tools the agent calls during artifact composition. They live in
 * the daemon, read from `skills/beaver-prototype/` (the v2 spec
 * extractor's output), and return small structured payloads suitable for
 * a tool-output channel.
 *
 *   beaver_search_components   — fuzzy search by name + description, with
 *                                 Beaver-primary ranking.
 *   beaver_get_component_spec  — full per-component spec (props, examples,
 *                                 referencedTypes, sibling sub-components).
 *   beaver_list_token_groups   — token group names with sample keys.
 *   beaver_get_tokens          — full values for one token group.
 *   beaver_search_docs         — full-text search over per-component docs.
 *   beaver_dry_run             — compile and headlessly mount a TSX
 *                                 candidate to surface errors before the
 *                                 user sees the iframe.
 *
 * The tool functions themselves take/return plain JSON objects. This
 * module does NOT wire them to a specific transport (MCP, native qwen
 * tool API, stdin-injection, etc.) — that adapter lives in the daemon's
 * agent-spawning code and varies by CLI. Tools here are protocol-agnostic
 * so the wiring can change without touching tool logic.
 *
 * Caching: every call hits disk (read JSON from skills/beaver-prototype/)
 * but the daemon process is long-lived; we cache parsed manifest +
 * specs in memory and invalidate on mtime change. Cache miss latency is
 * ~5–20 ms; cache hit is sub-ms.
 */
import { readFile, stat } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import type {
  Manifest,
  ManifestEntry,
  ComponentSpec,
  TokenGroup,
  TokenEntry,
  Tier,
} from '@beaver-open-design/spec-extractor/types';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface BeaverToolsContext {
  /** Absolute path to skills/beaver-prototype/ on disk. */
  skillDir: string;
  /**
   * Optional dry-run runner. If absent, beaver_dry_run returns
   * `{ ok: false, reason: 'unavailable' }` so the agent doesn't hang on
   * a missing dependency. The daemon is expected to wire this to a
   * JSDOM-or-Playwright shim that loads the same UMD the iframe uses.
   */
  dryRun?: BeaverDryRunFn;
}

export type BeaverDryRunFn = (
  source: string,
) => Promise<BeaverDryRunResult>;

// Search

export interface BeaverSearchComponentsInput {
  query: string;
  limit?: number;
}

export interface BeaverSearchComponentsHit {
  name: string;
  package: string;
  tier: Tier;
  kind: string;
  docSummary?: string;
  /** 0–1 relevance score; higher is better. */
  score: number;
}

export interface BeaverSearchComponentsOutput {
  results: BeaverSearchComponentsHit[];
  totalMatches: number;
}

// Spec

export interface BeaverGetComponentSpecInput {
  name: string;
}

export type BeaverGetComponentSpecOutput =
  | { ok: true; spec: ComponentSpec }
  | { ok: false; reason: 'not-found'; suggestions: string[] };

// Tokens

export interface BeaverListTokenGroupsOutput {
  groups: Array<{
    group: string;
    importPath: string;
    sampleKeys: string[];
    entryCount: number;
  }>;
}

export interface BeaverGetTokensInput {
  group: string;
}

export type BeaverGetTokensOutput =
  | { ok: true; group: TokenGroup }
  | { ok: false; reason: 'not-found'; available: string[] };

// Docs search

export interface BeaverSearchDocsInput {
  query: string;
  limit?: number;
}

export interface BeaverSearchDocsHit {
  /** "@beaver-ui/header/Header" form. */
  componentKey: string;
  /** Markdown excerpt around the match. */
  excerpt: string;
  /** Path under skillDir; useful for the agent if it wants the full doc. */
  docPath: string;
  score: number;
}

export interface BeaverSearchDocsOutput {
  results: BeaverSearchDocsHit[];
  totalMatches: number;
}

// Dry-run

export interface BeaverDryRunInput {
  source: string;
}

export type BeaverDryRunResult =
  | { ok: true }
  | {
      ok: false;
      reason: 'parse' | 'runtime' | 'unavailable';
      message: string;
      line?: number;
      column?: number;
      hint?: string;
    };

export type BeaverDryRunOutput = BeaverDryRunResult;

// ─── In-memory caches ──────────────────────────────────────────────────────

interface CacheSlot<T> {
  value: T;
  mtimeMs: number;
}

const manifestCache = new Map<string, CacheSlot<Manifest>>();
const specCache = new Map<string, CacheSlot<ComponentSpec | null>>();
const tokenGroupCache = new Map<string, CacheSlot<TokenGroup | null>>();
const docCache = new Map<string, CacheSlot<string>>();

async function readJsonCached<T>(
  cache: Map<string, CacheSlot<T>>,
  path: string,
  parser: (raw: string) => T,
): Promise<T | null> {
  let mtimeMs: number;
  try {
    const s = await stat(path);
    mtimeMs = s.mtimeMs;
  } catch {
    return null;
  }
  const cached = cache.get(path);
  if (cached && cached.mtimeMs === mtimeMs) return cached.value;

  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return null;
  }
  let parsed: T;
  try {
    parsed = parser(raw);
  } catch {
    return null;
  }
  cache.set(path, { value: parsed, mtimeMs });
  return parsed;
}

async function loadManifest(ctx: BeaverToolsContext): Promise<Manifest | null> {
  const path = join(ctx.skillDir, 'components.json');
  return readJsonCached<Manifest>(manifestCache, path, (raw) =>
    JSON.parse(raw) as Manifest,
  );
}

async function loadComponentSpec(
  ctx: BeaverToolsContext,
  name: string,
): Promise<ComponentSpec | null> {
  // Resolve via manifest (specPath) so renames in the future just work.
  const manifest = await loadManifest(ctx);
  if (!manifest) return null;
  const entry = manifest.components.find((c) => c.name === name);
  if (!entry) return null;
  const path = join(ctx.skillDir, entry.specPath);
  const cached = await readJsonCached<ComponentSpec | null>(
    specCache,
    path,
    (raw) => JSON.parse(raw) as ComponentSpec,
  );
  return cached ?? null;
}

async function loadTokenGroup(
  ctx: BeaverToolsContext,
  group: string,
): Promise<TokenGroup | null> {
  const safeName = group.replace(/[^a-zA-Z0-9_-]/g, '');
  if (!safeName) return null;
  const path = join(ctx.skillDir, 'tokens', `${safeName}.json`);
  return readJsonCached<TokenGroup | null>(
    tokenGroupCache,
    path,
    (raw) => JSON.parse(raw) as TokenGroup,
  );
}

async function loadDocFile(
  ctx: BeaverToolsContext,
  relPath: string,
): Promise<string | null> {
  const path = join(ctx.skillDir, relPath);
  return readJsonCached<string>(
    docCache,
    path,
    (raw) => raw,
  );
}

// ─── Tools ─────────────────────────────────────────────────────────────────

export async function beaverSearchComponents(
  ctx: BeaverToolsContext,
  input: BeaverSearchComponentsInput,
): Promise<BeaverSearchComponentsOutput> {
  const limit = clamp(input.limit ?? 8, 1, 25);
  const manifest = await loadManifest(ctx);
  if (!manifest) {
    return { results: [], totalMatches: 0 };
  }

  const query = (input.query ?? '').trim();
  if (!query) {
    // Empty query — list everything Beaver-primary first, capped.
    const everything = sortByTier(manifest.components);
    return {
      results: everything.slice(0, limit).map((e) => entryToHit(e, 0.5)),
      totalMatches: manifest.components.length,
    };
  }

  const scored = manifest.components
    .map((entry) => ({
      entry,
      score: scoreEntry(entry, query),
    }))
    .filter((s) => s.score > 0);

  // Sort: Beaver primary first (with score boost), then score, then name.
  scored.sort((a, b) => {
    if (a.entry.tier !== b.entry.tier) {
      return a.entry.tier === 'primary' ? -1 : 1;
    }
    if (a.score !== b.score) return b.score - a.score;
    return a.entry.name.localeCompare(b.entry.name);
  });

  return {
    results: scored.slice(0, limit).map((s) => entryToHit(s.entry, s.score)),
    totalMatches: scored.length,
  };
}

export async function beaverGetComponentSpec(
  ctx: BeaverToolsContext,
  input: BeaverGetComponentSpecInput,
): Promise<BeaverGetComponentSpecOutput> {
  const name = (input.name ?? '').trim();
  if (!name) {
    return { ok: false, reason: 'not-found', suggestions: [] };
  }
  const spec = await loadComponentSpec(ctx, name);
  if (spec) return { ok: true, spec };

  // Suggest similar names from the manifest.
  const manifest = await loadManifest(ctx);
  const suggestions = manifest
    ? manifest.components
        .filter((c) => similarName(c.name, name))
        .slice(0, 5)
        .map((c) => c.name)
    : [];
  return { ok: false, reason: 'not-found', suggestions };
}

export async function beaverListTokenGroups(
  ctx: BeaverToolsContext,
): Promise<BeaverListTokenGroupsOutput> {
  const manifest = await loadManifest(ctx);
  if (!manifest) return { groups: [] };

  const out: BeaverListTokenGroupsOutput['groups'] = [];
  for (const group of manifest.tokenGroups) {
    const data = await loadTokenGroup(ctx, group);
    if (!data) continue;
    out.push({
      group: data.group,
      importPath: data.importPath,
      sampleKeys: data.entries.slice(0, 5).map((e) => e.path),
      entryCount: data.entries.length,
    });
  }
  return { groups: out };
}

export async function beaverGetTokens(
  ctx: BeaverToolsContext,
  input: BeaverGetTokensInput,
): Promise<BeaverGetTokensOutput> {
  const data = await loadTokenGroup(ctx, input.group);
  if (data) return { ok: true, group: data };

  const manifest = await loadManifest(ctx);
  return {
    ok: false,
    reason: 'not-found',
    available: manifest?.tokenGroups ?? [],
  };
}

export async function beaverSearchDocs(
  ctx: BeaverToolsContext,
  input: BeaverSearchDocsInput,
): Promise<BeaverSearchDocsOutput> {
  const limit = clamp(input.limit ?? 5, 1, 15);
  const manifest = await loadManifest(ctx);
  if (!manifest) return { results: [], totalMatches: 0 };

  const query = (input.query ?? '').trim().toLowerCase();
  if (!query) return { results: [], totalMatches: 0 };

  const queryTerms = query.split(/\s+/).filter(Boolean);

  const hits: BeaverSearchDocsHit[] = [];
  for (const entry of manifest.components) {
    if (!entry.docPath) continue;
    const body = await loadDocFile(ctx, entry.docPath);
    if (!body) continue;
    const lowered = body.toLowerCase();
    let score = 0;
    for (const term of queryTerms) {
      const occurrences = countOccurrences(lowered, term);
      if (occurrences === 0) continue;
      score += occurrences * (term.length / 4); // longer terms weigh more
    }
    if (score === 0) continue;

    const excerpt = makeExcerpt(body, queryTerms);
    hits.push({
      componentKey: `${entry.package}/${entry.name}`,
      excerpt,
      docPath: entry.docPath,
      score,
    });
  }

  hits.sort((a, b) => b.score - a.score);
  return {
    results: hits.slice(0, limit),
    totalMatches: hits.length,
  };
}

export async function beaverDryRun(
  ctx: BeaverToolsContext,
  input: BeaverDryRunInput,
): Promise<BeaverDryRunOutput> {
  if (!ctx.dryRun) {
    return {
      ok: false,
      reason: 'unavailable',
      message:
        'Dry-run runner is not configured. Daemon must wire ctx.dryRun to a JSDOM/Playwright shim that loads the same UMD as the iframe.',
    };
  }
  return ctx.dryRun(input.source);
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function clamp(n: number, lo: number, hi: number): number {
  if (Number.isNaN(n)) return lo;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return Math.floor(n);
}

function entryToHit(
  entry: ManifestEntry,
  score: number,
): BeaverSearchComponentsHit {
  return {
    name: entry.name,
    package: entry.package,
    tier: entry.tier,
    kind: entry.kind,
    ...(entry.docSummary
      ? { docSummary: entry.docSummary }
      : {}),
    score,
  };
}

function sortByTier(entries: ManifestEntry[]): ManifestEntry[] {
  return entries.slice().sort((a, b) => {
    if (a.tier !== b.tier) return a.tier === 'primary' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

/**
 * Lightweight relevance scoring. We don't ship a fuzzy library here to
 * keep the daemon dependency-light; the heuristic is good enough for a
 * surface of ~1500 components:
 *
 *   - exact name match: 1.0
 *   - prefix on name: 0.85
 *   - substring on name: 0.7
 *   - kebab/snake-of-name as substring on query: 0.6
 *   - all query terms in description: 0.5
 *   - some query terms in description: 0.3
 *   - else 0
 */
function scoreEntry(entry: ManifestEntry, query: string): number {
  const q = query.toLowerCase();
  const name = entry.name.toLowerCase();
  if (name === q) return 1.0;
  if (name.startsWith(q)) return 0.85;
  if (name.includes(q)) return 0.7;

  const kebab = name.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
  if (kebab.includes(q)) return 0.6;

  const desc = (entry.docSummary ?? '').toLowerCase();
  if (desc) {
    const terms = q.split(/\s+/).filter(Boolean);
    const present = terms.filter((t) => desc.includes(t));
    if (present.length === terms.length) return 0.5;
    if (present.length > 0) return 0.3;
  }
  return 0;
}

function similarName(candidate: string, target: string): boolean {
  const a = candidate.toLowerCase();
  const b = target.toLowerCase();
  if (a === b) return true;
  if (a.startsWith(b) || b.startsWith(a)) return true;
  if (Math.abs(a.length - b.length) <= 2) {
    let common = 0;
    for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
      if (a[i] === b[i]) common += 1;
    }
    if (common / Math.max(a.length, b.length) > 0.7) return true;
  }
  return false;
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count += 1;
    idx += needle.length;
  }
  return count;
}

function makeExcerpt(body: string, terms: string[]): string {
  const lowered = body.toLowerCase();
  let bestIdx = 0;
  let bestScore = -1;
  for (const term of terms) {
    const idx = lowered.indexOf(term);
    if (idx >= 0 && idx + term.length > bestScore) {
      bestScore = idx + term.length;
      bestIdx = idx;
    }
  }
  const start = Math.max(0, bestIdx - 80);
  const end = Math.min(body.length, bestIdx + 240);
  let excerpt = body.slice(start, end);
  if (start > 0) excerpt = '…' + excerpt;
  if (end < body.length) excerpt = excerpt + '…';
  return excerpt.replace(/\s+/g, ' ').trim();
}

// ─── Synchronous variants for non-async transports ─────────────────────────
//
// Some agent tool transports require a synchronous handler signature.
// These thin wrappers read manifests synchronously (no caching, no mtime
// check) so they can be plugged into such transports. Use the async
// variants above whenever possible — they're cheaper.

export function beaverSearchComponentsSync(
  ctx: BeaverToolsContext,
  input: BeaverSearchComponentsInput,
): BeaverSearchComponentsOutput {
  const manifest = loadManifestSync(ctx);
  if (!manifest) return { results: [], totalMatches: 0 };
  const query = (input.query ?? '').trim();
  const limit = clamp(input.limit ?? 8, 1, 25);

  if (!query) {
    return {
      results: sortByTier(manifest.components)
        .slice(0, limit)
        .map((e) => entryToHit(e, 0.5)),
      totalMatches: manifest.components.length,
    };
  }
  const scored = manifest.components
    .map((entry) => ({ entry, score: scoreEntry(entry, query) }))
    .filter((s) => s.score > 0);
  scored.sort((a, b) => {
    if (a.entry.tier !== b.entry.tier) return a.entry.tier === 'primary' ? -1 : 1;
    if (a.score !== b.score) return b.score - a.score;
    return a.entry.name.localeCompare(b.entry.name);
  });
  return {
    results: scored.slice(0, limit).map((s) => entryToHit(s.entry, s.score)),
    totalMatches: scored.length,
  };
}

function loadManifestSync(ctx: BeaverToolsContext): Manifest | null {
  const path = join(ctx.skillDir, 'components.json');
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Manifest;
  } catch {
    return null;
  }
}

// ─── Tool descriptors for transport adapters ──────────────────────────────
//
// These describe each tool in a transport-neutral shape so the daemon's
// agent-spawning code can map them to MCP / native qwen / stdin-injection
// without re-stating schemas. The daemon's adapter generates whatever
// JSON-Schema the transport wants from these.

export interface BeaverToolDescriptor {
  name: string;
  description: string;
  parameters: Record<
    string,
    {
      type: 'string' | 'number' | 'boolean' | 'object';
      description: string;
      required: boolean;
    }
  >;
}

export const BEAVER_TOOL_DESCRIPTORS: BeaverToolDescriptor[] = [
  {
    name: 'beaver_search_components',
    description:
      "Search the Beaver UI design system for components matching a query (name, role, or use-case keywords). Returns component names with their package, tier (primary = Beaver, fallback = inner-DS), kind, and a one-line description. Beaver components rank above inner-DS at equal relevance. Always call this BEFORE writing JSX — never guess component names.",
    parameters: {
      query: {
        type: 'string',
        description: 'Free-text query: component name, role, or intent. Examples: "data table", "header with search", "filter bar".',
        required: true,
      },
      limit: {
        type: 'number',
        description: 'Maximum results to return. Default 8, max 25.',
        required: false,
      },
    },
  },
  {
    name: 'beaver_get_component_spec',
    description:
      "Fetch the full spec for a Beaver UI (or inner-DS) component: props with types/required/defaults/enum-values, examples, sibling sub-components from the same package, cross-package referenced types. Call this for EVERY component you intend to use; do not infer props.",
    parameters: {
      name: {
        type: 'string',
        description: 'Exact component name as returned by beaver_search_components.',
        required: true,
      },
    },
  },
  {
    name: 'beaver_list_token_groups',
    description:
      "List the design-token groups exposed by the inner DS (color, spacing, typography, animation, etc.). Returns each group's import path, sample keys, and total entry count.",
    parameters: {},
  },
  {
    name: 'beaver_get_tokens',
    description:
      "Fetch all tokens for one group as flat path → value entries (e.g., color.brand.primary.default → '#…'). Use for any visual override that the component prop doesn't already cover; never hardcode hex/px/font values.",
    parameters: {
      group: {
        type: 'string',
        description: 'Token group name from beaver_list_token_groups.',
        required: true,
      },
    },
  },
  {
    name: 'beaver_search_docs',
    description:
      "Full-text search the Beaver/inner-DS documentation corpus (Storybook MDX, JSDoc, README excerpts). Use when component spec alone isn't enough and you need usage patterns or 'how to use X with Y' guidance.",
    parameters: {
      query: {
        type: 'string',
        description: 'Free-text query.',
        required: true,
      },
      limit: {
        type: 'number',
        description: 'Maximum results. Default 5, max 15.',
        required: false,
      },
    },
  },
  {
    name: 'beaver_dry_run',
    description:
      "Compile and headlessly mount a TSX candidate against the live Beaver runtime. Returns { ok: true } or { ok: false, reason, message }. MANDATORY before every <artifact> emission — the user only sees iframes that pass this check.",
    parameters: {
      source: {
        type: 'string',
        description: 'The TSX source as you intend to ship it.',
        required: true,
      },
    },
  },
];
