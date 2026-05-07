/**
 * extract-tokens.ts — phase 3 of beaver:sync.
 *
 * Tokens live exclusively in the inner-DS. Beaver consumes them but does
 * not re-publish them. The pattern in inner-DS is `packages/design-tokens`
 * with sub-modules per group (`color.ts`, `spacing.ts`, `animation.ts`,
 * etc.), each of which exports frozen objects produced by something like
 * `Object.freeze({ ... })` or a wrapper helper.
 *
 * The previous (v1) extractor parsed these regex-style and bailed on
 * frozen objects. This v2 implementation uses TS Compiler API to:
 *
 *   1. Find the design-tokens package in node_modules.
 *   2. For each top-level exported const, resolve the type / value via
 *      checker.getTypeOfSymbolAtLocation.
 *   3. Walk the resolved object type, collecting `path → value` entries.
 *   4. Group entries by top-level export name (e.g. `color.brand.primary`
 *      goes under group `color`).
 *
 * The result is one JSON file per group, plus a top-level `index.json`
 * listing all groups. Models fetch the per-group file via
 * `beaver_get_tokens(group)`.
 */
import ts from 'typescript';
import { join } from 'node:path';
import { readFile, access, readdir } from 'node:fs/promises';
import type { TokenEntry, TokenGroup } from './types.js';

export interface ExtractTokensOptions {
  /** node_modules directory. */
  nodeModulesDir: string;
  /**
   * Inner-DS scope (e.g. '@inner-ds'). The function looks for
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
  const exports = checker.getExportsOfModule(fileSymbol);

  const groups: TokenGroup[] = [];
  for (const sym of exports) {
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
