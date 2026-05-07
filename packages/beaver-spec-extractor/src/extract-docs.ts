/**
 * extract-docs.ts — phase 4 of beaver:sync.
 *
 * Walks local source checkouts of Beaver and inner-DS, producing a
 * lightweight Markdown corpus for each component:
 *
 *   skills/beaver-prototype/docs/<package>/<Component>.md
 *
 * Sources, in order of preference:
 *   1. Storybook MDX files matching the component name (`*.docs.mdx` or
 *      `<Component>.mdx`).
 *   2. JSDoc / TSDoc block comments above the component's exported
 *      declaration in `src/**`.
 *   3. README.md inside the component's package, if it exists.
 *
 * The output is plain Markdown — no story render, no example execution,
 * just descriptive prose suitable for the model's `beaver_search_docs`
 * tool. Examples already live in components.json (extracted as code
 * snippets); docs are about *how to use* the component, not what its API
 * is.
 *
 * Note: source files are accessed via `--beaver` and `--inner` flags. If
 * either is missing, that source's docs are skipped silently. The model
 * can still operate from prop specs alone.
 */
import fg from 'fast-glob';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join, basename, dirname, sep } from 'node:path';

export interface ExtractDocsOptions {
  /** Local checkout of the Beaver source repo. */
  beaverRoot?: string;
  /** Local checkout of the inner-DS source repo. */
  innerRoot?: string;
  /** Output directory: `<skillDir>/docs`. */
  outDir: string;
}

export interface ExtractedDocs {
  files: DocFile[];
  /** Map: `<packageName>/<ComponentName>` → docPath relative to skillDir. */
  index: Record<string, string>;
  errors: string[];
}

export interface DocFile {
  /** "@beaver-ui/header" form. */
  packageName: string;
  /** "Header" form. */
  componentName: string;
  /** Path written, relative to outDir. */
  relativePath: string;
  /** Contents written. */
  body: string;
}

export async function extractDocs(
  options: ExtractDocsOptions,
): Promise<ExtractedDocs> {
  const errors: string[] = [];
  const files: DocFile[] = [];

  const roots: Array<{ root: string; tier: 'beaver' | 'inner' }> = [];
  if (options.beaverRoot) roots.push({ root: options.beaverRoot, tier: 'beaver' });
  if (options.innerRoot) roots.push({ root: options.innerRoot, tier: 'inner' });

  if (roots.length === 0) {
    errors.push('No --beaver or --inner roots provided; doc corpus will be empty.');
    return { files: [], index: {}, errors };
  }

  for (const { root } of roots) {
    try {
      const fromRoot = await scanRoot(root);
      files.push(...fromRoot);
    } catch (err) {
      errors.push(
        `Failed to scan ${root}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Materialize files on disk and build the index.
  const index: Record<string, string> = {};
  for (const f of files) {
    const absolute = join(options.outDir, f.relativePath);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, f.body, 'utf8');
    index[`${f.packageName}/${f.componentName}`] = f.relativePath;
  }

  return { files, index, errors };
}

/**
 * Walk a single source repo. Conventions assumed (matching what most DS
 * monorepos look like, including Beaver per the user's earlier description):
 *
 *   <root>/packages/<pkg>/package.json     ← name, version
 *   <root>/packages/<pkg>/src/**            ← .tsx / .ts (JSDoc source)
 *   <root>/packages/<pkg>/src/**.mdx        ← Storybook docs
 *   <root>/packages/<pkg>/README.md         ← package-level docs
 */
async function scanRoot(root: string): Promise<DocFile[]> {
  const out: DocFile[] = [];
  const packageJsons = await fg(['packages/*/package.json'], {
    cwd: root,
    absolute: true,
    onlyFiles: true,
    suppressErrors: true,
  });

  for (const pjPath of packageJsons) {
    try {
      const pjContent = await readFile(pjPath, 'utf8');
      const pj = JSON.parse(pjContent) as { name?: string };
      const pkgName = pj.name;
      if (!pkgName) continue;
      const pkgDir = dirname(pjPath);

      const components = await collectComponentDocs(pkgDir, pkgName);
      out.push(...components);
    } catch {
      // ignore unreadable / malformed
    }
  }

  return out;
}

async function collectComponentDocs(
  pkgDir: string,
  pkgName: string,
): Promise<DocFile[]> {
  const out: DocFile[] = [];

  // 1. README.md at the package root — used as fallback for every component
  //    in the package; surfaced with a `_package_` filename so it doesn't
  //    collide with a component named "README".
  let packageReadme = '';
  try {
    packageReadme = await readFile(join(pkgDir, 'README.md'), 'utf8');
  } catch {
    // pass
  }

  // 2. MDX files: per-component docs. We pair an MDX with a component name
  //    by basename (e.g. `Header.mdx` → component `Header`).
  const mdxFiles = await fg(['src/**/*.mdx', '*.mdx'], {
    cwd: pkgDir,
    absolute: true,
    onlyFiles: true,
    suppressErrors: true,
  });

  // 3. Source files: scan for top-level JSDoc above an exported function /
  //    const that looks like a component.
  const tsxFiles = await fg(['src/**/*.{ts,tsx}'], {
    cwd: pkgDir,
    absolute: true,
    onlyFiles: true,
    suppressErrors: true,
    ignore: ['**/*.stories.{ts,tsx}', '**/*.test.{ts,tsx}'],
  });

  // Collect per-component pieces.
  const perComponent = new Map<
    string,
    { mdx?: string; jsdoc?: string; sourceFile?: string }
  >();

  for (const mdxFile of mdxFiles) {
    const componentName = basename(mdxFile, '.mdx');
    if (!/^[A-Z]/.test(componentName)) continue;
    try {
      const body = await readFile(mdxFile, 'utf8');
      const cur = perComponent.get(componentName) ?? {};
      cur.mdx = stripMdxFrontmatter(body);
      perComponent.set(componentName, cur);
    } catch {
      // pass
    }
  }

  for (const tsxFile of tsxFiles) {
    try {
      const src = await readFile(tsxFile, 'utf8');
      const found = extractTopLevelComponentJsdoc(src);
      for (const [name, jsdoc] of found.entries()) {
        const cur = perComponent.get(name) ?? {};
        if (!cur.jsdoc) {
          cur.jsdoc = jsdoc;
          cur.sourceFile = tsxFile;
        }
        perComponent.set(name, cur);
      }
    } catch {
      // pass
    }
  }

  // Materialize one DocFile per component.
  for (const [componentName, pieces] of perComponent.entries()) {
    const sections: string[] = [];
    sections.push(`# ${componentName}`);
    sections.push('');
    sections.push(`Package: \`${pkgName}\``);
    sections.push('');
    if (pieces.jsdoc) {
      sections.push('## Description');
      sections.push('');
      sections.push(pieces.jsdoc);
      sections.push('');
    }
    if (pieces.mdx) {
      sections.push('## Storybook docs');
      sections.push('');
      sections.push(pieces.mdx);
      sections.push('');
    }
    if (!pieces.jsdoc && !pieces.mdx && packageReadme) {
      sections.push('## Package README (fallback)');
      sections.push('');
      sections.push(packageReadme);
      sections.push('');
    }
    if (pieces.jsdoc || pieces.mdx || packageReadme) {
      const body = sections.join('\n');
      const safePkg = pkgName.replace(/^@/, '').replace(/[/\\]/g, '__');
      const relativePath = `${safePkg}${sep}${componentName}.md`;
      out.push({ packageName: pkgName, componentName, relativePath, body });
    }
  }

  return out;
}

function stripMdxFrontmatter(body: string): string {
  const m = /^---\n[\s\S]*?\n---\n/.exec(body);
  return m ? body.slice(m[0].length) : body;
}

/**
 * Find top-level component declarations and pair each with its preceding
 * JSDoc block (if any). Lightweight — it covers the common shapes:
 *
 *   /** ... *\/
 *   export const Foo = ...
 *
 *   /** ... *\/
 *   export function Foo(...)
 *
 *   /** ... *\/
 *   const Foo = forwardRef(...)
 *   export { Foo };
 */
function extractTopLevelComponentJsdoc(src: string): Map<string, string> {
  const out = new Map<string, string>();
  // Greedy regex looking for JSDoc blocks immediately followed (whitespace
  // allowed) by an exported PascalCase declaration.
  const pattern = /\/\*\*([\s\S]*?)\*\/\s*export\s+(?:const|function|class|let|var)\s+([A-Z][A-Za-z0-9_]*)/g;
  for (const m of src.matchAll(pattern)) {
    const raw = m[1] ?? '';
    const name = m[2]!;
    const cleaned = cleanJsdocBlock(raw);
    if (cleaned) out.set(name, cleaned);
  }
  return out;
}

function cleanJsdocBlock(raw: string): string {
  return raw
    .split('\n')
    .map((line) => line.replace(/^\s*\*\s?/, ''))
    .filter((line) => !/^@\w+/.test(line.trim())) // drop @param, @returns
    .join('\n')
    .trim();
}
