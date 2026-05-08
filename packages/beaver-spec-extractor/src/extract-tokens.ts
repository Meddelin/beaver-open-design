/**
 * extract-tokens.ts — phase 3 of beaver:sync.
 *
 * Tokens live exclusively in the inner-DS. Beaver consumes them but does
 * not re-publish them.
 *
 * v2.1 strategy: dynamic `import()` of the actual JS module → walk
 * runtime objects via `Object.entries`. This is robust to whatever the
 * publisher's .d.ts looks like:
 *   - `export const designTokens: any` → can't see values via TS API,
 *     but at runtime it's a real object with real values.
 *   - `Object.freeze({...})` → looks like a plain object at runtime.
 *   - `as const` literal types → also real objects at runtime.
 *
 * The previous v2 implementation was TS-Compiler-API-only and bottomed
 * out at `typeToString(any) === "any"`, producing useless tokens — see
 * REMOTE-FIX-QUEUE.md #5.
 *
 * TS Compiler API is kept as a fallback for environments where dynamic
 * import fails (rare: package without `main`, ESM/CJS interop issues,
 * native add-ons). When it kicks in, we get *structure* (object key
 * paths) without values, which is still better than nothing — the model
 * can ask the user.
 *
 * Output: one JSON file per top-level export of the tokens package,
 * plus a top-level `index.json` listing groups. Models fetch the
 * per-group file via `beaver_get_tokens(group)`.
 */
import ts from 'typescript';
import { join } from 'node:path';
import { readFile, access, readdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import type { TokenEntry, TokenGroup, TokenObject } from './types.js';

export interface ExtractTokensOptions {
  /** node_modules directory. */
  nodeModulesDir: string;
  /**
   * Inner-DS scope (e.g. '@tui-react'). The function looks for
   * `<nodeModulesDir>/<scope>/design-tokens` first, then any package
   * inside the scope whose name ends with `design-tokens`.
   */
  innerScope: string;
  /**
   * If the tokens package's name is non-standard, the caller can provide
   * it directly. Overrides scope-based discovery.
   */
  explicitPackage?: string;
}

export interface ExtractedTokens {
  groups: TokenGroup[];
  errors: string[];
}

export async function extractTokens(
  options: ExtractTokensOptions,
): Promise<ExtractedTokens> {
  const errors: string[] = [];
  const tokensPkg = await findTokensPackage(options);
  if (!tokensPkg) {
    errors.push(
      `Could not locate a design-tokens package under ${options.nodeModulesDir}/${options.innerScope}.`,
    );
    return { groups: [], errors };
  }

  // ─── Primary path: dynamic import of the JS module ─────────────────────
  const runtimeResult = await extractTokensViaRuntime(tokensPkg);
  if (runtimeResult.ok) {
    return { groups: runtimeResult.groups, errors };
  }
  errors.push(
    `Dynamic import of ${tokensPkg.name} failed (${runtimeResult.reason}); falling back to TS Compiler API. Token values may be unresolved (typeof "any").`,
  );

  // ─── Fallback: TS Compiler API on the .d.ts ────────────────────────────
  const dtsPath = await findDtsForPackage(tokensPkg.dir);
  if (!dtsPath) {
    errors.push(`No .d.ts found in ${tokensPkg.dir}.`);
    return { groups: [], errors };
  }

  const program = ts.createProgram({
    rootNames: [dtsPath],
    options: {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      noEmit: true,
      skipLibCheck: true,
      strict: false,
    },
  });
  const sourceFile = program.getSourceFile(dtsPath);
  if (!sourceFile) {
    errors.push(`Cannot load source file ${dtsPath}.`);
    return { groups: [], errors };
  }

  const checker = program.getTypeChecker();
  const fileSymbol = checker.getSymbolAtLocation(sourceFile);
  if (!fileSymbol) {
    errors.push(`No file symbol for ${dtsPath}.`);
    return { groups: [], errors };
  }
  const symExports = checker.getExportsOfModule(fileSymbol);

  const groups: TokenGroup[] = [];
  for (const sym of symExports) {
    const decl = sym.declarations?.[0];
    if (!decl) continue;
    const type = checker.getTypeOfSymbolAtLocation(sym, decl);
    const entries = walkObjectType(type, checker, sym.name);
    if (entries.length === 0) continue;
    groups.push({
      group: sym.name,
      importPath: `${tokensPkg.name}/${sym.name}`,
      description: undefined,
      entries,
    });
  }

  return { groups, errors };
}

interface RuntimeExtractionOk {
  ok: true;
  groups: TokenGroup[];
}

interface RuntimeExtractionFail {
  ok: false;
  reason: string;
}

/**
 * Load the tokens module via Node's dynamic `import()` and walk the
 * runtime objects to produce token groups. This is the source of truth
 * for actual token values — the .d.ts may have erased them to type
 * aliases, but the JS file always has the literals.
 *
 * We try the module's package name first (e.g. `@inner/design-tokens`),
 * which lets Node honour the package's `exports` map and condition.
 * If that fails (some environments don't expose workspace deps to
 * dynamic imports), we fall back to a direct file URL.
 */
async function extractTokensViaRuntime(
  tokensPkg: FoundTokensPackage,
): Promise<RuntimeExtractionOk | RuntimeExtractionFail> {
  let mod: Record<string, unknown> | null = null;

  // Try package-name import first.
  try {
    mod = (await import(tokensPkg.name)) as Record<string, unknown>;
  } catch {
    // fall through to file-URL fallback
  }

  // Try direct file import if package-name didn't work.
  if (!mod) {
    try {
      const entry = await findRuntimeEntryFile(tokensPkg.dir);
      if (entry) {
        mod = (await import(pathToFileURL(entry).href)) as Record<string, unknown>;
      }
    } catch (err) {
      return {
        ok: false,
        reason: `dynamic import error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  if (!mod) {
    return {
      ok: false,
      reason: 'could not locate a JS entry to import',
    };
  }

  // Skip the ESM `default` re-export when present; iterate the rest as
  // top-level groups.
  const groups: TokenGroup[] = [];
  for (const [groupName, value] of Object.entries(mod)) {
    if (groupName === 'default') continue;
    if (value === null || typeof value !== 'object') continue;
    const entries = walkRuntimeObject(value as Record<string, unknown>, groupName, 0);
    if (entries.length === 0) continue;
    groups.push({
      group: groupName,
      importPath: `${tokensPkg.name}/${groupName}`,
      description: undefined,
      entries,
    });
  }

  if (groups.length === 0) {
    return {
      ok: false,
      reason:
        'module imported successfully but no enumerable object exports found at top level',
    };
  }
  return { ok: true, groups };
}

/**
 * Recursively walk a runtime JS object, collecting `path → value`
 * entries. Stops at primitives. Cycles are rare in token files but we
 * cap depth defensively.
 */
function walkRuntimeObject(
  obj: Record<string, unknown>,
  basePath: string,
  depth: number,
): TokenEntry[] {
  if (depth > 10) return [];
  const out: TokenEntry[] = [];
  for (const [key, value] of Object.entries(obj)) {
    const path = `${basePath}.${key}`;
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      out.push({ path, value });
    } else if (value === null || value === undefined) {
      out.push({ path, value: null });
    } else if (typeof value === 'object') {
      // Capture the whole nested object as a TokenObject leaf if it's
      // shallow enough to be useful, else recurse.
      const child = value as Record<string, unknown>;
      const childKeys = Object.keys(child);
      if (childKeys.length === 0) {
        out.push({ path, value: null });
      } else {
        // Distinguish between "leaf object" (e.g. `{ value: '#fff', meta: ... }`
        // tokens have small leaf shape) and "container" (deep nested
        // groups). Heuristic: if all child values are primitives and
        // there are ≤ 4 keys, treat as leaf.
        const allPrimitive = childKeys.every((k) => {
          const v = child[k];
          return v === null || typeof v !== 'object';
        });
        if (allPrimitive && childKeys.length <= 4) {
          const flat: TokenObject = {};
          for (const k of childKeys) {
            const v = child[k];
            if (
              typeof v === 'string' ||
              typeof v === 'number' ||
              typeof v === 'boolean' ||
              v === null
            ) {
              flat[k] = v;
            } else {
              flat[k] = null;
            }
          }
          out.push({ path, value: flat });
        } else {
          out.push(...walkRuntimeObject(child, path, depth + 1));
        }
      }
    }
    // Functions, symbols, etc. — skip silently.
  }
  return out;
}

async function findRuntimeEntryFile(
  pkgDir: string,
): Promise<string | null> {
  // Read package.json for `main`/`module`/`exports` clues, otherwise
  // probe common build outputs.
  try {
    const pjRaw = await readFile(join(pkgDir, 'package.json'), 'utf8');
    const pj = JSON.parse(pjRaw) as {
      main?: string;
      module?: string;
      exports?: unknown;
    };
    const candidates = [pj.module, pj.main].filter(
      (x): x is string => typeof x === 'string',
    );
    // Light parse of `exports`: if it's a string, use it; if an object
    // with a "." entry that's a string, use that.
    if (typeof pj.exports === 'string') {
      candidates.unshift(pj.exports);
    } else if (pj.exports && typeof pj.exports === 'object') {
      const dotEntry = (pj.exports as Record<string, unknown>)['.'];
      if (typeof dotEntry === 'string') candidates.unshift(dotEntry);
      else if (dotEntry && typeof dotEntry === 'object') {
        const importEntry =
          (dotEntry as Record<string, unknown>).import ??
          (dotEntry as Record<string, unknown>).default;
        if (typeof importEntry === 'string') candidates.unshift(importEntry);
      }
    }
    for (const rel of candidates) {
      const file = join(pkgDir, rel);
      try {
        await access(file);
        return file;
      } catch {
        // try next
      }
    }
  } catch {
    // pass
  }

  // Last-ditch probes.
  for (const rel of [
    'dist/index.mjs',
    'dist/index.js',
    'lib/index.js',
    'index.mjs',
    'index.js',
  ]) {
    const file = join(pkgDir, rel);
    try {
      await access(file);
      return file;
    } catch {
      // next
    }
  }
  return null;
}

/**
 * Recursively walk an object type and produce flat path → value entries.
 * Numbers, strings, booleans and null become leaves; nested objects
 * descend; everything else is captured as the type's textual
 * representation (the model can still use it as opaque token reference).
 */
function walkObjectType(
  type: ts.Type,
  checker: ts.TypeChecker,
  basePath: string,
  depth = 0,
): TokenEntry[] {
  if (depth > 6) return [];

  // Literal types.
  if (type.isStringLiteral?.() || (type.flags & ts.TypeFlags.StringLiteral) !== 0) {
    return [{ path: basePath, value: (type as ts.StringLiteralType).value }];
  }
  if (
    type.isNumberLiteral?.() ||
    (type.flags & ts.TypeFlags.NumberLiteral) !== 0
  ) {
    return [{ path: basePath, value: (type as ts.NumberLiteralType).value }];
  }
  if (type.flags & ts.TypeFlags.BooleanLiteral) {
    // ts represents `true` and `false` literal types specially; cast and read.
    const intrinsic = (type as { intrinsicName?: string }).intrinsicName;
    if (intrinsic === 'true') return [{ path: basePath, value: true }];
    if (intrinsic === 'false') return [{ path: basePath, value: false }];
  }
  if (type.flags & ts.TypeFlags.Null) {
    return [{ path: basePath, value: null }];
  }
  if (type.flags & ts.TypeFlags.Undefined) {
    return [{ path: basePath, value: null }];
  }

  // Object types: descend into properties.
  if (type.flags & ts.TypeFlags.Object) {
    // See extract-props.ts for context — `getApparentProperties` is a `Type`
    // method, not a `TypeChecker` method. The local agent caught this and
    // applied a workaround (#2 in REMOTE-FIX-QUEUE.md); now landed as
    // permanent fix.
    const props = checker.getPropertiesOfType(type);
    if (props.length === 0) {
      // Empty object or unresolvable — fall back to type text.
      return [
        {
          path: basePath,
          value: checker.typeToString(type, undefined, ts.TypeFormatFlags.NoTruncation),
        },
      ];
    }
    const entries: TokenEntry[] = [];
    for (const prop of props) {
      const decl = prop.valueDeclaration ?? prop.declarations?.[0];
      if (!decl) continue;
      const child = checker.getTypeOfSymbolAtLocation(prop, decl);
      const childPath = `${basePath}.${prop.name}`;
      entries.push(...walkObjectType(child, checker, childPath, depth + 1));
    }
    return entries;
  }

  // Generic / union / intersection / unknown — stringify the type and use
  // it as an opaque token. This still gives the model something to read,
  // and it round-trips back into JSON.
  const txt = checker.typeToString(
    type,
    undefined,
    ts.TypeFormatFlags.NoTruncation,
  );
  return [{ path: basePath, value: txt }];
}

interface FoundTokensPackage {
  name: string;
  dir: string;
}

async function findTokensPackage(
  options: ExtractTokensOptions,
): Promise<FoundTokensPackage | null> {
  if (options.explicitPackage) {
    const dir = join(
      options.nodeModulesDir,
      ...options.explicitPackage.split('/'),
    );
    try {
      await access(dir);
      return { name: options.explicitPackage, dir };
    } catch {
      return null;
    }
  }

  // Conventional path: <scope>/design-tokens.
  const conventional = join(
    options.nodeModulesDir,
    ...options.innerScope.split('/'),
    'design-tokens',
  );
  try {
    await access(conventional);
    return {
      name: `${options.innerScope}/design-tokens`,
      dir: conventional,
    };
  } catch {
    // fall through
  }

  // Browse the scope dir and find any `*-design-tokens` or `*tokens*` package.
  const scopeDir = join(options.nodeModulesDir, ...options.innerScope.split('/'));
  try {
    const entries = await readdir(scopeDir);
    for (const e of entries) {
      if (/tokens/i.test(e)) {
        return { name: `${options.innerScope}/${e}`, dir: join(scopeDir, e) };
      }
    }
  } catch {
    // pass
  }
  return null;
}

async function findDtsForPackage(pkgDir: string): Promise<string | null> {
  for (const candidate of [
    'dist/index.d.ts',
    'dist/index.d.mts',
    'lib/index.d.ts',
    'index.d.ts',
  ]) {
    const file = join(pkgDir, candidate);
    try {
      await access(file);
      return file;
    } catch {
      // try next
    }
  }
  try {
    const pjRaw = await readFile(join(pkgDir, 'package.json'), 'utf8');
    const pj = JSON.parse(pjRaw) as { types?: string; typings?: string };
    const t = pj.types ?? pj.typings;
    if (t) {
      const file = join(pkgDir, t);
      await access(file);
      return file;
    }
  } catch {
    // pass
  }
  return null;
}
