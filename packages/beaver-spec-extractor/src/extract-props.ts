/**
 * extract-props.ts — phase 2 of beaver:sync.
 *
 * For each component name resolved by introspect-bundle.ts, walk the
 * package's published `.d.ts` and extract:
 *
 *   - the props interface / type literal,
 *   - prop name / required / type-as-text / default value (when expressed
 *     in the .d.ts via `?` or default param),
 *   - JSDoc summary,
 *   - string-literal union enum values,
 *   - cross-package referenced types (so the model can drill in via
 *     `beaver_get_component_spec(typeName)`).
 *
 * Why .d.ts instead of source: the published .d.ts has types already
 * resolved by tsc — utility types (`Omit`, `Partial`, intersections) are
 * baked. The source TS may have richer JSDoc but unresolved types; the
 * difference is: in source we'd need to re-implement type resolution (huge
 * surface), in .d.ts we just read what the publisher's tsc produced.
 *
 * Edge cases handled:
 *   - Props embedded in function signature (no separate `XxxProps`
 *     interface): we extract from the parameter annotation directly.
 *   - `React.ForwardRefExoticComponent<X>`, `React.FC<X>`,
 *     `React.MemoExoticComponent<X>`: all unwrap to the X parameter.
 *   - Types declared but not exported: still surfaced as referencedTypes
 *     so the model knows they exist (linked but not resolved).
 */
import ts from 'typescript';
import { join } from 'node:path';
import { readFile, access } from 'node:fs/promises';
import type {
  ComponentSpec,
  PropSpec,
  TypeReference,
  Tier,
} from './types.js';

export interface ExtractPropsOptions {
  /** Package → list of component names to look up in that package. */
  packageToNames: Record<string, string[]>;
  /** node_modules directory. */
  nodeModulesDir: string;
  /** Override for which packages count as "primary" (Beaver) vs "fallback". */
  isPrimary?: (pkg: string) => boolean;
  /**
   * If set, the extractor logs detailed diagnostics for components matching
   * this name to stderr — type information after each unwrap step, props
   * count, and which fallback (if any) was triggered. Useful when most
   * specs come back with empty props and you need to know why for one
   * specific component.
   */
  debugComponent?: string;
}

export interface ExtractedSpecs {
  specs: ComponentSpec[];
  /** Errors per package; useful in sync.ts for surfacing what failed. */
  errors: Array<{ package: string; error: string }>;
}

export async function extractProps(
  options: ExtractPropsOptions,
): Promise<ExtractedSpecs> {
  const isPrimary = options.isPrimary ?? defaultIsPrimary;
  const specs: ComponentSpec[] = [];
  const errors: Array<{ package: string; error: string }> = [];

  // Resolve react / react-dom .d.ts ONCE up-front so each package program
  // can include them as additional rootNames. Without this, props extraction
  // returns empty for any component typed as `React.FC<X>` /
  // `React.ForwardRefExoticComponent<...>` because the React identifier
  // can't be resolved by the checker — see REMOTE-FIX-QUEUE.md #4.
  const reactDts = await findDtsAtPaths([
    join(options.nodeModulesDir, 'react', 'index.d.ts'),
    join(options.nodeModulesDir, '@types', 'react', 'index.d.ts'),
  ]);
  const reactDomDts = await findDtsAtPaths([
    join(options.nodeModulesDir, 'react-dom', 'index.d.ts'),
    join(options.nodeModulesDir, '@types', 'react-dom', 'index.d.ts'),
  ]);
  const reactRootNames = [reactDts, reactDomDts].filter(
    (p): p is string => typeof p === 'string',
  );

  for (const [pkg, names] of Object.entries(options.packageToNames)) {
    try {
      const dtsPath = await findDtsForPackage(pkg, options.nodeModulesDir);
      if (!dtsPath) {
        errors.push({
          package: pkg,
          error: 'No .d.ts found (looked for dist/index.d.ts, dist/index.d.mts, index.d.ts).',
        });
        continue;
      }
      const program = ts.createProgram({
        rootNames: [dtsPath, ...reactRootNames],
        options: {
          target: ts.ScriptTarget.ES2020,
          module: ts.ModuleKind.ESNext,
          moduleResolution: ts.ModuleResolutionKind.NodeNext,
          allowJs: false,
          declaration: true,
          noEmit: true,
          skipLibCheck: true,
          strict: false,
          jsx: ts.JsxEmit.ReactJSX,
          types: ['react', 'react-dom'],
          // Anchor module resolution at the workspace's node_modules so
          // pnpm-style symlinked packages resolve their own peer deps.
          baseUrl: options.nodeModulesDir,
        },
      });
      const sourceFile = program.getSourceFile(dtsPath);
      if (!sourceFile) {
        errors.push({ package: pkg, error: `Cannot load source file ${dtsPath}` });
        continue;
      }
      const checker = program.getTypeChecker();
      const tier: Tier = isPrimary(pkg) ? 'primary' : 'fallback';

      const allSiblingNames = collectExportedNames(sourceFile);

      for (const name of names) {
        const spec = extractSingleComponent({
          name,
          pkg,
          tier,
          sourceFile,
          checker,
          siblingComponents: allSiblingNames.filter((n) => n !== name),
          debug: options.debugComponent === name,
        });
        if (spec) specs.push(spec);
      }
    } catch (err) {
      errors.push({
        package: pkg,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { specs, errors };
}

function defaultIsPrimary(pkg: string): boolean {
  return pkg.startsWith('@beaver-ui/');
}

async function findDtsAtPaths(candidates: string[]): Promise<string | null> {
  for (const file of candidates) {
    try {
      await access(file);
      return file;
    } catch {
      // try next
    }
  }
  return null;
}

async function findDtsForPackage(
  pkg: string,
  nodeModulesDir: string,
): Promise<string | null> {
  const pkgDir = join(nodeModulesDir, ...pkg.split('/'));
  for (const candidate of [
    'dist/index.d.ts',
    'dist/index.d.mts',
    'dist/types/index.d.ts',
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
  // Fall back: read package.json's `types` field if present.
  try {
    const pjRaw = await readFile(join(pkgDir, 'package.json'), 'utf8');
    const pj = JSON.parse(pjRaw) as { types?: string; typings?: string };
    const typesRel = pj.types ?? pj.typings;
    if (typesRel) {
      const file = join(pkgDir, typesRel);
      await access(file);
      return file;
    }
  } catch {
    // pass
  }
  return null;
}

function collectExportedNames(sourceFile: ts.SourceFile): string[] {
  const names: string[] = [];
  ts.forEachChild(sourceFile, function visit(node: ts.Node) {
    if (
      (ts.isVariableStatement(node) ||
        ts.isFunctionDeclaration(node) ||
        ts.isClassDeclaration(node) ||
        ts.isInterfaceDeclaration(node) ||
        ts.isTypeAliasDeclaration(node)) &&
      hasExportModifier(node)
    ) {
      if (ts.isVariableStatement(node)) {
        for (const decl of node.declarationList.declarations) {
          if (ts.isIdentifier(decl.name)) names.push(decl.name.text);
        }
      } else if (node.name && ts.isIdentifier(node.name)) {
        names.push(node.name.text);
      }
    }
    if (ts.isExportDeclaration(node) && node.exportClause) {
      if (ts.isNamedExports(node.exportClause)) {
        for (const el of node.exportClause.elements) {
          names.push(el.name.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  });
  return [...new Set(names)];
}

function hasExportModifier(node: ts.HasModifiers): boolean {
  const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return !!mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

interface ExtractSingleArgs {
  name: string;
  pkg: string;
  tier: Tier;
  sourceFile: ts.SourceFile;
  checker: ts.TypeChecker;
  siblingComponents: string[];
  debug?: boolean;
}

function extractSingleComponent(args: ExtractSingleArgs): ComponentSpec | null {
  const dbg = args.debug ? makeDebugLogger(args.name, args.pkg) : null;

  const symbol = findExportedSymbol(args.sourceFile, args.checker, args.name);
  if (!symbol) {
    dbg?.(`no exported symbol named "${args.name}" in ${args.pkg}`);
    return {
      name: args.name,
      package: args.pkg,
      tier: args.tier,
      importStatement: `import { ${args.name} } from '${args.pkg}';`,
      props: [],
      examples: [],
      siblingComponents: args.siblingComponents,
    };
  }

  const decl = symbol.declarations?.[0];
  const docSummary = jsDocSummary(decl);
  const propsType = resolvePropsType(symbol, args.checker, dbg);
  let props: PropSpec[] = propsType
    ? extractPropsFromType(propsType, args.checker)
    : [];

  // AST fallback: if type-checker resolution returned no props, try parsing
  // the .d.ts text directly. This catches cases where the React types
  // didn't resolve (e.g. the workspace doesn't have @types/react in
  // resolution range, or symbol shapes the unwrap logic doesn't cover).
  if (props.length === 0) {
    dbg?.('checker returned 0 props; trying AST fallback');
    const astProps = extractPropsViaAst(args.sourceFile, args.name);
    if (astProps && astProps.length > 0) {
      dbg?.(`AST fallback yielded ${astProps.length} props`);
      props = astProps;
    } else {
      dbg?.('AST fallback also returned 0 props');
    }
  } else {
    dbg?.(`checker yielded ${props.length} props`);
  }

  return {
    name: args.name,
    package: args.pkg,
    tier: args.tier,
    importStatement: `import { ${args.name} } from '${args.pkg}';`,
    ...(docSummary ? { docSummary } : {}),
    props,
    examples: [],
    siblingComponents: args.siblingComponents,
  };
}

function makeDebugLogger(name: string, pkg: string) {
  return (message: string) => {
    process.stderr.write(`[debug ${pkg}#${name}] ${message}\n`);
  };
}

function findExportedSymbol(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  name: string,
): ts.Symbol | undefined {
  const fileSymbol = checker.getSymbolAtLocation(sourceFile);
  if (!fileSymbol) return undefined;
  const exports = checker.getExportsOfModule(fileSymbol);
  return exports.find((s) => s.name === name);
}

/**
 * Given an exported symbol that we believe is a React component, dig out
 * the props type. We try a few shapes in order:
 *
 *   - `React.FC<X>` / `FC<X>` → X
 *   - `React.ForwardRefExoticComponent<RefAttributes<R> & X>` → X
 *   - `React.MemoExoticComponent<typeof Foo>` → recurse into typeof
 *   - function declaration `function Foo(props: X): JSX.Element` → X
 *   - arrow `const Foo: (props: X) => JSX.Element` → X
 *   - class component `class Foo extends Component<X>` → X
 *
 * If we can't figure it out, we return undefined and the caller treats
 * the spec as having empty props.
 */
function resolvePropsType(
  symbol: ts.Symbol,
  checker: ts.TypeChecker,
  dbg: ((message: string) => void) | null,
): ts.Type | undefined {
  const type = checker.getTypeOfSymbolAtLocation(
    symbol,
    symbol.declarations?.[0] ?? (symbol.valueDeclaration as ts.Node),
  );

  if (dbg) {
    const txt = checker.typeToString(type, undefined, ts.TypeFormatFlags.NoTruncation);
    dbg(`symbol type: ${truncateForDebug(txt)}`);
  }

  // Function-call signatures: extract the first parameter type.
  const callSigs = type.getCallSignatures();
  dbg?.(`call signatures: ${callSigs.length}`);
  if (callSigs.length > 0) {
    const first = callSigs[0]!;
    if (first.parameters.length > 0) {
      const param = first.parameters[0]!;
      const paramDecl = param.valueDeclaration ?? param.declarations?.[0];
      if (paramDecl) {
        const propsType = checker.getTypeOfSymbolAtLocation(param, paramDecl);
        dbg?.(
          `props type from call sig: ${truncateForDebug(checker.typeToString(propsType, undefined, ts.TypeFormatFlags.NoTruncation))}`,
        );
        return propsType;
      }
    }
  }

  // Generic class / object types like `ForwardRefExoticComponent<P>`:
  // walk the type's apparent type arguments.
  const apparent = checker.getApparentType(type);
  const apparentArgs =
    ((apparent as ts.TypeReference & { typeArguments?: ts.Type[] }).typeArguments ??
      apparent.aliasTypeArguments ??
      []).length;
  dbg?.(`apparent type args: ${apparentArgs}`);
  const propsFromGeneric = unwrapReactComponentGeneric(apparent, checker);
  if (propsFromGeneric) {
    dbg?.(
      `unwrapped generic to: ${truncateForDebug(checker.typeToString(propsFromGeneric, undefined, ts.TypeFormatFlags.NoTruncation))}`,
    );
    return propsFromGeneric;
  }

  dbg?.('all unwrap strategies failed; checker returns undefined');
  return undefined;
}

function truncateForDebug(s: string): string {
  return s.length > 200 ? s.slice(0, 200) + '…' : s;
}

function unwrapReactComponentGeneric(
  type: ts.Type,
  checker: ts.TypeChecker,
): ts.Type | undefined {
  // type.aliasTypeArguments / type.target / type.typeArguments — different
  // entry points in the TS API depending on the construction shape.
  const objType = type as ts.TypeReference & { typeArguments?: ts.Type[] };
  const args =
    objType.typeArguments ??
    type.aliasTypeArguments ??
    [];

  // Pick the most likely "props" arg: usually the only one, or the first
  // that's an object type.
  for (const arg of args) {
    if (arg.flags & ts.TypeFlags.Object) {
      // For ForwardRefExoticComponent<RefAttributes<R> & P>, we want P —
      // unwrap intersections.
      const intersection = (arg as ts.IntersectionType).types;
      if (intersection && Array.isArray(intersection)) {
        // Strip RefAttributes-like types. Heuristic: drop types that have
        // exactly the property `ref` and nothing else useful.
        const candidates = intersection.filter(
          (t) => !looksLikeRefAttributesType(t, checker),
        );
        if (candidates.length === 1) return candidates[0];
        if (candidates.length > 1) {
          // intersection is meaningful — return as-is, the prop extractor
          // will walk all member props via getPropertiesOfType.
          return arg;
        }
      }
      return arg;
    }
  }
  return undefined;
}

function looksLikeRefAttributesType(
  type: ts.Type,
  checker: ts.TypeChecker,
): boolean {
  const symbol = type.getSymbol();
  const name = symbol?.name;
  if (
    name === 'RefAttributes' ||
    name === 'ClassAttributes' ||
    name === 'Attributes'
  ) {
    return true;
  }
  // structural fallback: only `ref` and maybe `key`.
  const props = checker.getPropertiesOfType(type).map((p) => p.name);
  if (props.length === 0) return false;
  const interestingProps = props.filter((p) => p !== 'ref' && p !== 'key');
  return interestingProps.length === 0;
}

function extractPropsFromType(
  propsType: ts.Type,
  checker: ts.TypeChecker,
): PropSpec[] {
  const out: PropSpec[] = [];
  // `getApparentProperties` was a `Type` method, not a `TypeChecker` method —
  // mistake in v2 initial draft. `getPropertiesOfType` is the correct
  // checker-level call; for the prop-extraction case (object types) the
  // returned property set is what we want.
  const properties = checker.getPropertiesOfType(propsType);
  for (const prop of properties) {
    const decl = prop.valueDeclaration ?? prop.declarations?.[0];
    if (!decl) continue;
    const propType = checker.getTypeOfSymbolAtLocation(prop, decl);
    const typeText = checker.typeToString(
      propType,
      decl,
      ts.TypeFormatFlags.NoTruncation,
    );
    const required = !(prop.flags & ts.SymbolFlags.Optional);
    const description = jsDocSummary(decl);
    const enumValues = extractStringLiteralUnion(propType, checker);
    const referencedTypes = extractReferencedTypes(propType, checker);

    out.push({
      name: prop.name,
      type: typeText,
      required,
      ...(description ? { description } : {}),
      ...(enumValues && enumValues.length > 0 ? { enumValues } : {}),
      ...(referencedTypes && referencedTypes.length > 0 ? { referencedTypes } : {}),
    });
  }
  return out;
}

function extractStringLiteralUnion(
  type: ts.Type,
  checker: ts.TypeChecker,
): string[] | undefined {
  if (!(type.flags & ts.TypeFlags.Union)) return undefined;
  const u = type as ts.UnionType;
  const values: string[] = [];
  for (const member of u.types) {
    if (
      member.isStringLiteral() ||
      (member.flags & ts.TypeFlags.StringLiteral) !== 0
    ) {
      const value = (member as ts.StringLiteralType).value;
      if (typeof value === 'string') values.push(value);
    } else {
      // Mixed union — probably string + number + boolean. Treat as not-an-enum.
      return undefined;
    }
    void checker; // suppress unused-warning in some strict configs
  }
  return values;
}

function extractReferencedTypes(
  type: ts.Type,
  checker: ts.TypeChecker,
): TypeReference[] | undefined {
  // We follow type aliases / interfaces named in the type text. Pure
  // structural types (e.g. `{ a: string }`) don't yield references; named
  // types (e.g. `TuiSize`, `IconName`, `ButtonVariant`) do.
  const refs = new Map<string, TypeReference>();
  collectNamedTypeRefs(type, checker, refs);
  if (refs.size === 0) return undefined;
  return [...refs.values()];
}

function collectNamedTypeRefs(
  type: ts.Type,
  checker: ts.TypeChecker,
  acc: Map<string, TypeReference>,
  depth = 0,
): void {
  if (depth > 4) return; // cap recursion

  const symbol = type.aliasSymbol ?? type.getSymbol();
  if (symbol && (symbol.flags & ts.SymbolFlags.Type) !== 0) {
    const decl = symbol.declarations?.[0];
    const sourceFile = decl?.getSourceFile();
    const filePath = sourceFile?.fileName ?? '';
    const pkg = packageFromFilePath(filePath);
    if (pkg && symbol.name && /^[A-Z]/.test(symbol.name)) {
      // Heuristic: only collect named types that look like exported types
      // (PascalCase). `T`, `U`, `Args` etc. are mostly internal generics.
      acc.set(symbol.name, {
        name: symbol.name,
        package: pkg,
        resolved: false,
      });
    }
  }

  if (type.flags & ts.TypeFlags.Union) {
    for (const sub of (type as ts.UnionType).types) {
      collectNamedTypeRefs(sub, checker, acc, depth + 1);
    }
  } else if (type.flags & ts.TypeFlags.Intersection) {
    for (const sub of (type as ts.IntersectionType).types) {
      collectNamedTypeRefs(sub, checker, acc, depth + 1);
    }
  }
}

/**
 * Heuristic: extract the npm package name from a node_modules absolute
 * path. Works for `@scope/pkg` and `pkg`.
 */
function packageFromFilePath(filePath: string): string | undefined {
  const m = /node_modules[\\/](@[^\\/]+[\\/][^\\/]+|[^\\/@]+)/.exec(filePath);
  if (!m) return undefined;
  return m[1]!.replace(/\\/g, '/');
}

/**
 * AST fallback for prop extraction. Used when the TypeChecker-based path
 * returns no props (typical when React types don't resolve in the
 * compiler program). Walks the .d.ts AST directly without consulting the
 * checker — less accurate (won't follow type aliases across files) but
 * works in degraded environments.
 *
 * Strategy:
 *   1. Find the exported declaration with the requested name.
 *   2. Walk its TypeNode looking for the props type:
 *      - `ForwardRefExoticComponent<X>` / `FC<X>` / `MemoExoticComponent<X>`:
 *        unwrap to type argument X.
 *      - For `X & RefAttributes<R>` intersection: drop the RefAttributes side.
 *      - X may be a TypeLiteral (inline `{ ... }`) or a TypeReference
 *        (named, e.g. `ButtonProps`).
 *   3. If TypeLiteral — walk its members directly.
 *   4. If TypeReference — find the matching `interface ButtonProps` or
 *      `type ButtonProps = { ... }` in the same source file; walk that.
 *
 * Returns undefined when none of the above shapes match, so the caller
 * keeps the empty `props: []` rather than crashing.
 */
function extractPropsViaAst(
  sourceFile: ts.SourceFile,
  componentName: string,
): PropSpec[] | undefined {
  const propsTypeNode = findPropsTypeNodeForName(sourceFile, componentName);
  if (!propsTypeNode) return undefined;

  // Walk the type node. If it's a TypeReference, resolve to the
  // local interface/type-alias declaration.
  const literal = resolveToTypeLiteral(propsTypeNode, sourceFile);
  if (!literal) return undefined;

  return propsFromMembers(literal.members);
}

function findPropsTypeNodeForName(
  sourceFile: ts.SourceFile,
  componentName: string,
): ts.TypeNode | undefined {
  let result: ts.TypeNode | undefined;

  ts.forEachChild(sourceFile, function visit(node) {
    if (result) return;
    // export declare const Foo: <type>
    if (
      ts.isVariableStatement(node) &&
      hasExportModifier(node) &&
      node.declarationList.declarations.length > 0
    ) {
      for (const decl of node.declarationList.declarations) {
        if (
          ts.isIdentifier(decl.name) &&
          decl.name.text === componentName &&
          decl.type
        ) {
          result = unwrapPropsTypeArgument(decl.type);
          return;
        }
      }
    }
    // export function Foo(props: <type>): ...
    if (
      ts.isFunctionDeclaration(node) &&
      hasExportModifier(node) &&
      node.name?.text === componentName
    ) {
      const propsParam = node.parameters[0];
      if (propsParam?.type) {
        result = propsParam.type;
        return;
      }
    }
    // export class Foo extends Component<<type>>
    if (
      ts.isClassDeclaration(node) &&
      hasExportModifier(node) &&
      node.name?.text === componentName
    ) {
      for (const heritage of node.heritageClauses ?? []) {
        if (heritage.token !== ts.SyntaxKind.ExtendsKeyword) continue;
        for (const expr of heritage.types) {
          if (expr.typeArguments && expr.typeArguments.length > 0) {
            result = expr.typeArguments[0];
            return;
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  });

  return result;
}

/**
 * Given a type that wraps the props (e.g.
 * `ForwardRefExoticComponent<RefAttributes<R> & ButtonProps>`), pull out
 * the props type node. Returns the props node if recognized, otherwise
 * the input — caller will deal with it.
 */
function unwrapPropsTypeArgument(typeNode: ts.TypeNode): ts.TypeNode {
  if (ts.isTypeReferenceNode(typeNode) && typeNode.typeArguments) {
    const refName = ts.isIdentifier(typeNode.typeName)
      ? typeNode.typeName.text
      : typeNode.typeName.right?.text ?? '';
    if (
      /^(ForwardRefExoticComponent|FC|FunctionComponent|MemoExoticComponent|VoidFunctionComponent|ComponentType|NamedExoticComponent)$/.test(
        refName,
      )
    ) {
      const arg = typeNode.typeArguments[0];
      if (arg) return stripRefAttributes(arg);
    }
  }
  return typeNode;
}

function stripRefAttributes(typeNode: ts.TypeNode): ts.TypeNode {
  if (!ts.isIntersectionTypeNode(typeNode)) return typeNode;
  const survivors = typeNode.types.filter((t) => {
    if (ts.isTypeReferenceNode(t)) {
      const refName = ts.isIdentifier(t.typeName)
        ? t.typeName.text
        : t.typeName.right?.text ?? '';
      return !/^(RefAttributes|ClassAttributes|Attributes)$/.test(refName);
    }
    return true;
  });
  if (survivors.length === 1) return survivors[0]!;
  return typeNode;
}

function resolveToTypeLiteral(
  typeNode: ts.TypeNode,
  sourceFile: ts.SourceFile,
): ts.TypeLiteralNode | undefined {
  if (ts.isTypeLiteralNode(typeNode)) return typeNode;
  if (ts.isTypeReferenceNode(typeNode) && ts.isIdentifier(typeNode.typeName)) {
    const aliasName = typeNode.typeName.text;
    let found: ts.TypeLiteralNode | undefined;
    ts.forEachChild(sourceFile, function visit(node) {
      if (found) return;
      if (
        ts.isInterfaceDeclaration(node) &&
        node.name.text === aliasName
      ) {
        // interface members shape == TypeLiteral.members. Synthesize.
        found = ts.factory.createTypeLiteralNode(node.members);
        return;
      }
      if (
        ts.isTypeAliasDeclaration(node) &&
        node.name.text === aliasName &&
        ts.isTypeLiteralNode(node.type)
      ) {
        found = node.type;
        return;
      }
      ts.forEachChild(node, visit);
    });
    return found;
  }
  if (ts.isIntersectionTypeNode(typeNode)) {
    // Multi-membered intersection — fold into one synthetic TypeLiteral.
    const merged: ts.TypeElement[] = [];
    for (const sub of typeNode.types) {
      const lit = resolveToTypeLiteral(sub, sourceFile);
      if (lit) merged.push(...lit.members);
    }
    if (merged.length > 0) {
      return ts.factory.createTypeLiteralNode(merged);
    }
  }
  return undefined;
}

function propsFromMembers(
  members: ts.NodeArray<ts.TypeElement> | ts.TypeElement[],
): PropSpec[] {
  const out: PropSpec[] = [];
  for (const member of members) {
    if (!ts.isPropertySignature(member)) continue;
    if (!member.name || !ts.isIdentifier(member.name)) continue;
    const name = member.name.text;
    const required = !member.questionToken;
    const typeText = member.type ? typeTextOfNode(member.type) : 'unknown';
    const enumValues = stringLiteralUnionFromNode(member.type);
    const description = jsDocSummary(member);
    out.push({
      name,
      type: typeText,
      required,
      ...(description ? { description } : {}),
      ...(enumValues && enumValues.length > 0 ? { enumValues } : {}),
    });
  }
  return out;
}

function typeTextOfNode(typeNode: ts.TypeNode): string {
  // Get the source range of the node and slice the file's text to keep
  // the user's exact original notation. ts.factory printing would
  // re-format and lose readability.
  const sf = typeNode.getSourceFile();
  if (!sf) return 'unknown';
  return sf.text.slice(typeNode.pos, typeNode.end).trim();
}

function stringLiteralUnionFromNode(
  typeNode: ts.TypeNode | undefined,
): string[] | undefined {
  if (!typeNode || !ts.isUnionTypeNode(typeNode)) return undefined;
  const values: string[] = [];
  for (const sub of typeNode.types) {
    if (
      ts.isLiteralTypeNode(sub) &&
      ts.isStringLiteral(sub.literal)
    ) {
      values.push(sub.literal.text);
    } else {
      return undefined; // mixed union; not enum-shaped
    }
  }
  return values;
}

function jsDocSummary(decl: ts.Node | undefined): string | undefined {
  if (!decl) return undefined;
  const tags = ts.getJSDocCommentsAndTags(decl);
  if (!tags || tags.length === 0) return undefined;
  for (const t of tags) {
    if (ts.isJSDoc(t)) {
      const c = t.comment;
      if (typeof c === 'string') return c.trim() || undefined;
      if (Array.isArray(c)) {
        const text = c
          .map((part) => (typeof part === 'string' ? part : part.text))
          .filter(Boolean)
          .join(' ')
          .trim();
        if (text) return text;
      }
    }
  }
  return undefined;
}
