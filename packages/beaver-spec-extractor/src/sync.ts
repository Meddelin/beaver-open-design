import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { dirname, join, relative, basename } from 'node:path';
import fg from 'fast-glob';
import { Project, SyntaxKind, type InterfaceDeclaration, type TypeAliasDeclaration } from 'ts-morph';

export type SyncOptions = {
  beaverRoot: string;
  innerRoot: string | undefined;
  outDir: string;
};

export type Tier = 'preferred' | 'primitive';

export type ExtractedProp = {
  name: string;
  type: string;
  required: boolean;
  default?: string;
  description?: string;
  enumValues?: string[];
};

export type ExtractedComponent = {
  name: string;
  package: string;
  tier: Tier;
  importStatement: string;
  summary?: string;
  props: ExtractedProp[];
  examples?: string[];
};

export type ExtractedTokenGroup = {
  importPath: string;
  values: Record<string, unknown>;
};

export type Manifest = {
  generatedAt: string;
  generatedBy: string;
  beaverVersion: string | null;
  innerDsVersion: string | null;
  components: ExtractedComponent[];
  tokens: Record<string, ExtractedTokenGroup>;
};

export async function runSync(opts: SyncOptions): Promise<void> {
  await assertDir(opts.beaverRoot, '--beaver');

  const beaverPackages = await listPackages(opts.beaverRoot);
  if (beaverPackages.length === 0) {
    throw new Error(
      `No packages found at ${opts.beaverRoot}/packages/*. Is this a Beaver UI checkout?`,
    );
  }

  const innerPackages = opts.innerRoot
    ? await listPackages(opts.innerRoot)
    : [];

  const beaverComponents: ExtractedComponent[] = [];
  for (const pkg of beaverPackages) {
    const found = await extractComponentsFromPackage(pkg, 'preferred');
    beaverComponents.push(...found);
  }

  const innerComponents: ExtractedComponent[] = [];
  let innerTokens: Record<string, ExtractedTokenGroup> = {};
  for (const pkg of innerPackages) {
    if (basename(pkg.path) === 'design-tokens') {
      innerTokens = await extractTokensFromPackage(pkg);
      continue;
    }
    const found = await extractComponentsFromPackage(pkg, 'primitive');
    innerComponents.push(...found);
  }

  const manifest: Manifest = {
    generatedAt: new Date().toISOString(),
    generatedBy: '@beaver-open-design/spec-extractor',
    beaverVersion: await readVersion(opts.beaverRoot),
    innerDsVersion: opts.innerRoot ? await readVersion(opts.innerRoot) : null,
    components: dedupeComponents([...beaverComponents, ...innerComponents]),
    tokens: innerTokens,
  };

  await writeManifest(opts.outDir, manifest);
  await writeComponentRefs(opts.outDir, manifest.components);
  await writeTokensRef(opts.outDir, manifest.tokens);
  await writeIndex(opts.outDir, manifest);

  console.log(
    `wrote ${manifest.components.length} components, ${Object.keys(manifest.tokens).length} token groups → ${opts.outDir}`,
  );
}

async function assertDir(path: string, label: string): Promise<void> {
  try {
    await access(path);
  } catch {
    throw new Error(`${label} path does not exist: ${path}`);
  }
}

type PackageInfo = {
  path: string;
  name: string;
  version: string | undefined;
  pkgJson: Record<string, unknown>;
};

async function listPackages(root: string): Promise<PackageInfo[]> {
  const candidates = await fg(['packages/*/package.json'], {
    cwd: root,
    absolute: true,
    onlyFiles: true,
    suppressErrors: true,
  });
  const out: PackageInfo[] = [];
  for (const file of candidates) {
    try {
      const raw = await readFile(file, 'utf8');
      const json = JSON.parse(raw) as Record<string, unknown>;
      const name = typeof json.name === 'string' ? json.name : null;
      if (!name) continue;
      out.push({
        path: dirname(file),
        name,
        version: typeof json.version === 'string' ? json.version : undefined,
        pkgJson: json,
      });
    } catch {
      // ignore broken package.json
    }
  }
  return out;
}

async function readVersion(root: string): Promise<string | null> {
  try {
    const raw = await readFile(join(root, 'package.json'), 'utf8');
    const json = JSON.parse(raw) as Record<string, unknown>;
    return typeof json.version === 'string' ? json.version : null;
  } catch {
    return null;
  }
}

async function extractComponentsFromPackage(
  pkg: PackageInfo,
  tier: Tier,
): Promise<ExtractedComponent[]> {
  const stories = await fg(
    ['src/**/*.stories.{ts,tsx}', 'src/**/*.stories.{ts,tsx}', 'stories/**/*.stories.{ts,tsx}'],
    { cwd: pkg.path, absolute: true, onlyFiles: true, suppressErrors: true },
  );

  const componentNames = new Set<string>();
  for (const file of stories) {
    const meta = await readStoryMeta(file);
    if (meta) componentNames.add(meta);
  }

  // Fall back to the package's own exports if there are no stories.
  if (componentNames.size === 0) {
    const indexNames = await readPackageExports(pkg.path);
    for (const n of indexNames) componentNames.add(n);
  }

  if (componentNames.size === 0) return [];

  const propsByComponent = await extractPropsFromTypes(pkg.path);

  const out: ExtractedComponent[] = [];
  for (const name of componentNames) {
    out.push({
      name,
      package: pkg.name,
      tier,
      importStatement: `import { ${name} } from '${pkg.name}';`,
      summary: undefined,
      props: propsByComponent.get(name) ?? [],
      examples: [],
    });
  }
  return out;
}

async function readStoryMeta(file: string): Promise<string | null> {
  try {
    const src = await readFile(file, 'utf8');
    // Storybook CSF: `const meta: Meta<typeof Foo> = { component: Foo }` —
    // grab the component identifier from `component:`.
    const m = src.match(/component\s*:\s*([A-Z][A-Za-z0-9_]*)/);
    if (m) return m[1] ?? null;
    return null;
  } catch {
    return null;
  }
}

async function readPackageExports(pkgPath: string): Promise<string[]> {
  const candidates = ['src/index.ts', 'src/index.tsx', 'index.ts', 'index.tsx'];
  for (const rel of candidates) {
    const file = join(pkgPath, rel);
    try {
      const src = await readFile(file, 'utf8');
      const names = new Set<string>();
      for (const m of src.matchAll(/export\s+(?:const|function|class)\s+([A-Z][A-Za-z0-9_]*)/g)) {
        names.add(m[1]!);
      }
      for (const m of src.matchAll(/export\s*\{\s*([^}]+)\}/g)) {
        for (const part of (m[1] ?? '').split(',')) {
          const trimmed = part.trim().split(/\s+as\s+/)[0]!.trim();
          if (/^[A-Z][A-Za-z0-9_]*$/.test(trimmed)) names.add(trimmed);
        }
      }
      return [...names];
    } catch {
      // try next
    }
  }
  return [];
}

async function extractPropsFromTypes(
  pkgPath: string,
): Promise<Map<string, ExtractedProp[]>> {
  const project = new Project({
    compilerOptions: {
      noEmit: true,
      allowJs: false,
      jsx: 4, // ReactJSX
      strict: false,
      skipLibCheck: true,
    },
  });
  const files = await fg(['src/**/*.{ts,tsx,d.ts}', 'dist/**/*.d.ts'], {
    cwd: pkgPath,
    absolute: true,
    onlyFiles: true,
    suppressErrors: true,
  });
  for (const file of files) {
    try {
      project.addSourceFileAtPath(file);
    } catch {
      // ignore unreadable
    }
  }

  const out = new Map<string, ExtractedProp[]>();
  for (const sourceFile of project.getSourceFiles()) {
    for (const decl of sourceFile.getInterfaces()) {
      const target = matchPropsName(decl.getName());
      if (target) out.set(target, mergeProps(out.get(target), interfaceToProps(decl)));
    }
    for (const decl of sourceFile.getTypeAliases()) {
      const target = matchPropsName(decl.getName());
      if (target) out.set(target, mergeProps(out.get(target), typeAliasToProps(decl)));
    }
  }
  return out;
}

function matchPropsName(name: string): string | null {
  // Foo, FooProps, IFooProps -> Foo
  const m = name.match(/^I?([A-Z][A-Za-z0-9_]*?)Props$/);
  return m ? m[1]! : null;
}

function interfaceToProps(decl: InterfaceDeclaration): ExtractedProp[] {
  const props: ExtractedProp[] = [];
  for (const sig of decl.getProperties()) {
    const typeNode = sig.getTypeNode();
    const typeText = typeNode ? typeNode.getText() : sig.getType().getText(sig);
    const isOptional = sig.hasQuestionToken();
    const enumValues = collectStringLiteralUnion(typeText);
    const jsdoc = sig.getJsDocs().map((d) => d.getDescription().trim()).filter(Boolean).join(' ');
    props.push({
      name: sig.getName(),
      type: typeText,
      required: !isOptional,
      description: jsdoc || undefined,
      ...(enumValues.length > 0 ? { enumValues } : {}),
    });
  }
  return props;
}

function typeAliasToProps(decl: TypeAliasDeclaration): ExtractedProp[] {
  const typeNode = decl.getTypeNode();
  if (!typeNode) return [];
  if (typeNode.getKind() === SyntaxKind.TypeLiteral) {
    const literal = typeNode.asKindOrThrow(SyntaxKind.TypeLiteral);
    return literal.getProperties().map((sig) => {
      const tn = sig.getTypeNode();
      const typeText = tn ? tn.getText() : sig.getType().getText(sig);
      const enumValues = collectStringLiteralUnion(typeText);
      return {
        name: sig.getName(),
        type: typeText,
        required: !sig.hasQuestionToken(),
        ...(enumValues.length > 0 ? { enumValues } : {}),
      };
    });
  }
  return [];
}

function mergeProps(
  existing: ExtractedProp[] | undefined,
  next: ExtractedProp[],
): ExtractedProp[] {
  if (!existing || existing.length === 0) return next;
  const map = new Map(existing.map((p) => [p.name, p]));
  for (const p of next) if (!map.has(p.name)) map.set(p.name, p);
  return [...map.values()];
}

function collectStringLiteralUnion(typeText: string): string[] {
  const matches = typeText.match(/'[^']+'/g);
  if (!matches) return [];
  return matches.map((m) => m.slice(1, -1));
}

function dedupeComponents(components: ExtractedComponent[]): ExtractedComponent[] {
  const seen = new Map<string, ExtractedComponent>();
  for (const c of components) {
    const key = `${c.package}::${c.name}`;
    if (!seen.has(key)) seen.set(key, c);
  }
  return [...seen.values()].sort((a, b) => {
    if (a.tier !== b.tier) return a.tier === 'preferred' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

async function extractTokensFromPackage(
  pkg: PackageInfo,
): Promise<Record<string, ExtractedTokenGroup>> {
  const sources = await fg(['src/**/*.{ts,d.ts}', '*.{ts,d.ts}'], {
    cwd: pkg.path,
    absolute: true,
    onlyFiles: true,
    suppressErrors: true,
  });

  const out: Record<string, ExtractedTokenGroup> = {};
  for (const file of sources) {
    const group = basename(file).replace(/\.(d\.ts|ts)$/, '');
    if (!group || group === 'index') continue;
    try {
      const src = await readFile(file, 'utf8');
      const values = extractExportValues(src);
      if (Object.keys(values).length === 0) continue;
      out[group] = {
        importPath: `${pkg.name}/${group}`,
        values,
      };
    } catch {
      // ignore
    }
  }
  return out;
}

function extractExportValues(src: string): Record<string, unknown> {
  // Best-effort: grab `export const NAME = ...;` and parse the right-hand
  // side as JSON when it looks JSON-ish, otherwise keep it as a string.
  const out: Record<string, unknown> = {};
  for (const m of src.matchAll(/export\s+const\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([^;]+);/g)) {
    const name = m[1]!;
    const rhs = (m[2] ?? '').trim();
    out[name] = parseRhs(rhs);
  }
  return out;
}

function parseRhs(rhs: string): unknown {
  if (/^['"`].*['"`]$/.test(rhs)) return rhs.slice(1, -1);
  if (/^-?\d+(?:\.\d+)?$/.test(rhs)) return Number(rhs);
  if (rhs === 'true' || rhs === 'false') return rhs === 'true';
  // Try JSON after light normalisation: TS object literals often use unquoted
  // keys + trailing commas. Cheap fix-up:
  const normalised = rhs
    .replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":')
    .replace(/,\s*([}\]])/g, '$1')
    .replace(/'/g, '"');
  try {
    return JSON.parse(normalised);
  } catch {
    return rhs;
  }
}

async function writeManifest(outDir: string, manifest: Manifest): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const file = join(outDir, 'components.json');
  await writeFile(file, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
}

async function writeComponentRefs(
  outDir: string,
  components: ExtractedComponent[],
): Promise<void> {
  const dir = join(outDir, 'references', 'components');
  await mkdir(dir, { recursive: true });

  for (const c of components) {
    const lines: string[] = [];
    lines.push(`# ${c.name}`);
    lines.push('');
    lines.push(`**Package:** \`${c.package}\``);
    lines.push(`**Tier:** ${c.tier}`);
    lines.push(`**Import:** \`${c.importStatement}\``);
    lines.push('');
    if (c.summary) {
      lines.push('## Summary');
      lines.push('');
      lines.push(c.summary);
      lines.push('');
    }
    if (c.props.length > 0) {
      lines.push('## Props');
      lines.push('');
      lines.push('| Name | Type | Required | Description |');
      lines.push('|------|------|----------|-------------|');
      for (const p of c.props) {
        const desc = (p.description ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
        const type = p.enumValues && p.enumValues.length > 0
          ? p.enumValues.map((v) => `\`'${v}'\``).join(' \\| ')
          : `\`${p.type.replace(/\|/g, '\\|')}\``;
        lines.push(`| \`${p.name}\` | ${type} | ${p.required ? 'yes' : 'no'} | ${desc} |`);
      }
      lines.push('');
    }
    if (c.tier === 'primitive') {
      lines.push('> **Use only if no Beaver alternative fits and a Beaver primitive composition cannot replace it.**');
      lines.push('');
    }
    if (c.examples && c.examples.length > 0) {
      lines.push('## Examples');
      lines.push('');
      for (const ex of c.examples) {
        lines.push('```tsx');
        lines.push(ex);
        lines.push('```');
        lines.push('');
      }
    }
    await writeFile(join(dir, `${c.name}.md`), lines.join('\n'), 'utf8');
  }
}

async function writeTokensRef(
  outDir: string,
  tokens: Record<string, ExtractedTokenGroup>,
): Promise<void> {
  const lines: string[] = [];
  lines.push('# Beaver design tokens');
  lines.push('');
  lines.push('> Auto-generated by `pnpm beaver:sync`. Do not edit.');
  lines.push('');
  if (Object.keys(tokens).length === 0) {
    lines.push('_No tokens captured. Did you pass `--inner` to a checkout that contains `packages/design-tokens`?_');
    lines.push('');
  } else {
    for (const [group, body] of Object.entries(tokens)) {
      lines.push(`## ${group}`);
      lines.push('');
      lines.push('```ts');
      lines.push(`import * as ${group} from '${body.importPath}';`);
      lines.push('```');
      lines.push('');
      const entries = Object.entries(body.values).slice(0, 50);
      if (entries.length > 0) {
        lines.push('| Token | Value |');
        lines.push('|-------|-------|');
        for (const [name, value] of entries) {
          const v = typeof value === 'string' ? value : JSON.stringify(value);
          lines.push(`| \`${name}\` | \`${v.replace(/\|/g, '\\|')}\` |`);
        }
        lines.push('');
        if (Object.keys(body.values).length > entries.length) {
          lines.push(`_…and ${Object.keys(body.values).length - entries.length} more. See \`components.json\` for the full list._`);
          lines.push('');
        }
      }
    }
  }
  await writeFile(join(outDir, 'references', 'tokens.md'), lines.join('\n'), 'utf8');
}

async function writeIndex(outDir: string, manifest: Manifest): Promise<void> {
  const preferred = manifest.components.filter((c) => c.tier === 'preferred');
  const primitives = manifest.components.filter((c) => c.tier === 'primitive');

  const lines: string[] = [];
  lines.push('# Beaver UI component index');
  lines.push('');
  lines.push(
    `Auto-generated ${manifest.generatedAt} from Beaver ${manifest.beaverVersion ?? '?'}` +
      (manifest.innerDsVersion ? ` and inner DS ${manifest.innerDsVersion}` : ''),
  );
  lines.push('');
  lines.push('## Preferred components (`@beaver-ui/*`)');
  lines.push('');
  for (const c of preferred) {
    lines.push(`- [\`${c.name}\`](./components/${c.name}.md) — ${c.package}`);
  }
  lines.push('');
  lines.push('## Primitive fallback (`@<inner-ds>/*`)');
  lines.push('');
  if (primitives.length === 0) {
    lines.push('_None synced yet. Pass `--inner <path-to-inner-ds>` next time you run `beaver:sync`._');
  } else {
    for (const c of primitives) {
      lines.push(`- [\`${c.name}\`](./components/${c.name}.md) — ${c.package}`);
    }
  }
  lines.push('');
  lines.push('## Tokens');
  lines.push('');
  lines.push('See [`tokens.md`](./tokens.md).');
  lines.push('');
  await writeFile(join(outDir, 'references', 'index.md'), lines.join('\n'), 'utf8');
}

void relative;
