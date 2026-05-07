/**
 * sync.ts — orchestrator for `pnpm beaver:sync`.
 *
 * Runs four extractor passes in order and writes the combined manifest +
 * per-component artifacts to `skills/beaver-prototype/`.
 *
 *   1. introspectBundle — load apps/beaver-runtime/dist/beaver.umd.js,
 *      enumerate window.Beaver, resolve name → package via dynamic import
 *      of each runtime dep.
 *   2. extractProps — for each (package, names[]) pair from step 1, walk
 *      the published .d.ts and pull props with full types, defaults,
 *      enum unions, JSDoc, cross-package refs.
 *   3. extractTokens — walk @inner-ds/design-tokens for frozen-object
 *      values, group by top-level export.
 *   4. extractDocs — scan source checkouts (Beaver + inner-DS) for MDX,
 *      JSDoc, READMEs; produce per-component Markdown files.
 *
 * Outputs:
 *   skills/beaver-prototype/components.json     — lean manifest (names + tier + kind + paths)
 *   skills/beaver-prototype/specs/<Name>.json   — full per-component spec
 *   skills/beaver-prototype/tokens/<group>.json — token group values
 *   skills/beaver-prototype/tokens/index.json   — list of groups
 *   skills/beaver-prototype/docs/<package>/<Name>.md — doc corpus
 *   skills/beaver-prototype/docs/index.json     — name → doc path
 *
 * The classifier for `kind` is intentionally NOT run inline — it requires
 * an LLM call per component, which is too expensive for default sync.
 * Run `pnpm beaver:classify` separately when you want kind labels.
 */
import { mkdir, writeFile, access, readFile } from 'node:fs/promises';
import { join, dirname, posix, sep } from 'node:path';
import { introspectBundle, type IntrospectorKind } from './introspect-bundle.js';
import { extractProps } from './extract-props.js';
import { extractTokens } from './extract-tokens.js';
import { extractDocs } from './extract-docs.js';
import type {
  ExtractorInputs,
  ManifestEntry,
  Manifest,
  ComponentSpec,
  TokenGroup,
} from './types.js';

const DEFAULT_BEAVER_PRIMARY_SCOPE = '@beaver-ui';
const DEFAULT_INNER_SCOPE = '@inner-ds';

export interface SyncOptions extends ExtractorInputs {
  /** Override the package scope considered "primary" (Beaver). */
  primaryScope?: string;
  /** Override the scope where inner-DS lives. */
  innerScope?: string;
  /** Bundle introspector to use. Default 'jsdom'. */
  introspector?: IntrospectorKind;
}

export interface SyncResult {
  manifest: Manifest;
  errors: string[];
  componentSpecCount: number;
  tokenGroupCount: number;
  docFileCount: number;
}

export async function runSync(options: SyncOptions): Promise<SyncResult> {
  const errors: string[] = [];
  const primaryScope = options.primaryScope ?? DEFAULT_BEAVER_PRIMARY_SCOPE;
  const innerScope = options.innerScope ?? DEFAULT_INNER_SCOPE;

  // ─── Phase 1: bundle introspection ─────────────────────────────────────
  await assertExists(options.bundlePath, 'bundle');
  const introspection = await introspectBundle({
    bundlePath: options.bundlePath,
    nodeModulesDir: options.nodeModulesDir,
    introspector: options.introspector ?? 'jsdom',
    runtimePackageJson: join(
      options.repoRoot,
      'apps',
      'beaver-runtime',
      'package.json',
    ),
  });

  // Filter to only component-classified exports.
  const componentExports = introspection.exports.filter(
    (e) => e.classification === 'component',
  );

  // Group component names by package, derived from packageOf map. Names
  // for which no package was resolved fall under a synthetic "@unknown"
  // bucket so they still reach the manifest (the model needs to know they
  // exist; the dot-spec just won't have props).
  const packageToNames: Record<string, string[]> = {};
  for (const exp of componentExports) {
    const pkg = introspection.packageOf[exp.name] ?? '@unknown';
    if (!packageToNames[pkg]) packageToNames[pkg] = [];
    packageToNames[pkg].push(exp.name);
  }

  // ─── Phase 2: per-component prop extraction ────────────────────────────
  const propsResult = await extractProps({
    packageToNames,
    nodeModulesDir: options.nodeModulesDir,
    isPrimary: (pkg) => pkg.startsWith(primaryScope + '/') || pkg === primaryScope,
  });
  for (const e of propsResult.errors) {
    errors.push(`extract-props (${e.package}): ${e.error}`);
  }

  // ─── Phase 3: token extraction ─────────────────────────────────────────
  const tokensResult = await extractTokens({
    nodeModulesDir: options.nodeModulesDir,
    innerScope,
  });
  errors.push(...tokensResult.errors.map((e) => `extract-tokens: ${e}`));

  // ─── Phase 4: docs corpus ──────────────────────────────────────────────
  const docsOutDir = join(options.skillDir, 'docs');
  const docsResult = await extractDocs({
    beaverRoot: options.beaverRoot,
    innerRoot: options.innerRoot,
    outDir: docsOutDir,
  });
  errors.push(...docsResult.errors.map((e) => `extract-docs: ${e}`));

  // ─── Build the lean manifest ───────────────────────────────────────────
  const manifest = buildManifest({
    propSpecs: propsResult.specs,
    docIndex: docsResult.index,
    tokenGroupNames: tokensResult.groups.map((g) => g.group),
    beaverVersion: await readVersion(options.nodeModulesDir, primaryScope, 'components'),
    innerDsVersion: await readVersion(options.nodeModulesDir, innerScope, 'components'),
  });

  // ─── Materialize all artifacts to disk ─────────────────────────────────
  await materialize({
    skillDir: options.skillDir,
    manifest,
    propSpecs: propsResult.specs,
    tokenGroups: tokensResult.groups,
  });

  return {
    manifest,
    errors,
    componentSpecCount: propsResult.specs.length,
    tokenGroupCount: tokensResult.groups.length,
    docFileCount: docsResult.files.length,
  };
}

interface BuildManifestArgs {
  propSpecs: ComponentSpec[];
  docIndex: Record<string, string>;
  tokenGroupNames: string[];
  beaverVersion: string | null;
  innerDsVersion: string | null;
}

function buildManifest(args: BuildManifestArgs): Manifest {
  const components: ManifestEntry[] = [];
  for (const spec of args.propSpecs) {
    const docKey = `${spec.package}/${spec.name}`;
    const docPath = args.docIndex[docKey];
    components.push({
      name: spec.name,
      package: spec.package,
      tier: spec.tier,
      kind: 'unknown', // populated by `pnpm beaver:classify` later
      specPath: posix.join('specs', `${spec.name}.json`),
      ...(docPath ? { docPath: posix.join('docs', toPosix(docPath)) } : {}),
      ...(spec.description
        ? { oneLineDescription: firstLine(spec.description) }
        : {}),
    });
  }

  // Stable sort: Beaver primary first, then by package, then by name.
  components.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier === 'primary' ? -1 : 1;
    if (a.package !== b.package) return a.package.localeCompare(b.package);
    return a.name.localeCompare(b.name);
  });

  return {
    generatedAt: new Date().toISOString(),
    generatedBy: '@beaver-open-design/spec-extractor v2',
    beaverVersion: args.beaverVersion,
    innerDsVersion: args.innerDsVersion,
    components,
    tokenGroups: args.tokenGroupNames.slice().sort(),
  };
}

interface MaterializeArgs {
  skillDir: string;
  manifest: Manifest;
  propSpecs: ComponentSpec[];
  tokenGroups: TokenGroup[];
}

async function materialize(args: MaterializeArgs): Promise<void> {
  // Write components.json (the lean manifest).
  const manifestPath = join(args.skillDir, 'components.json');
  await mkdir(dirname(manifestPath), { recursive: true });
  await writeFile(
    manifestPath,
    JSON.stringify(args.manifest, null, 2) + '\n',
    'utf8',
  );

  // Per-component specs.
  const specsDir = join(args.skillDir, 'specs');
  await mkdir(specsDir, { recursive: true });
  for (const spec of args.propSpecs) {
    const file = join(specsDir, `${spec.name}.json`);
    await writeFile(file, JSON.stringify(spec, null, 2) + '\n', 'utf8');
  }

  // Per-group tokens.
  const tokensDir = join(args.skillDir, 'tokens');
  await mkdir(tokensDir, { recursive: true });
  for (const group of args.tokenGroups) {
    const file = join(tokensDir, `${group.group}.json`);
    await writeFile(file, JSON.stringify(group, null, 2) + '\n', 'utf8');
  }
  await writeFile(
    join(tokensDir, 'index.json'),
    JSON.stringify(
      {
        groups: args.tokenGroups.map((g) => ({
          group: g.group,
          importPath: g.importPath,
          entryCount: g.entries.length,
        })),
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );
}

async function readVersion(
  nodeModulesDir: string,
  scope: string,
  pkg: string,
): Promise<string | null> {
  try {
    const file = join(nodeModulesDir, ...scope.split('/'), pkg, 'package.json');
    const content = await readFile(file, 'utf8');
    const parsed = JSON.parse(content) as { version?: string };
    return parsed.version ?? null;
  } catch {
    return null;
  }
}

async function assertExists(path: string, label: string): Promise<void> {
  try {
    await access(path);
  } catch {
    throw new Error(
      `Required ${label} not found at ${path}. Did you run pnpm beaver:build-runtime?`,
    );
  }
}

function toPosix(p: string): string {
  return p.split(sep).join('/');
}

function firstLine(s: string): string {
  const trimmed = s.trim();
  const idx = trimmed.indexOf('\n');
  return idx === -1 ? trimmed : trimmed.slice(0, idx);
}
