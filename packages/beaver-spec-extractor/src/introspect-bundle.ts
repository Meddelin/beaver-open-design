/**
 * introspect-bundle.ts — phase 1 of beaver:sync.
 *
 * Loads the built UMD bundle (`apps/beaver-runtime/dist/beaver.umd.js`) in
 * a JSDOM environment, reads `Object.keys(window.Beaver)`, classifies each
 * exported name (component / hook / utility / tokens-namespace), and
 * resolves each name back to its source package by side-channel —
 * dynamically loading each Beaver / inner-DS package from node_modules and
 * matching its exported names.
 *
 * Why this approach: the bundle is the single source of truth about what
 * is *actually* available at preview time. Parsing source trees or stories
 * is error-prone (sub-components in separate files, hybrid story formats,
 * non-standard prop names). The bundle either exports a name or it
 * doesn't; this avoids the false-positives we hit in v1.
 *
 * The result feeds extract-props.ts (which reads the .d.ts of each
 * resolved package to fill in prop specs) and the manifest builder in
 * sync.ts.
 *
 * NOTE on JSDOM behaviour: a few corp-internal components attach side-effect
 * code to `window` on load (e.g. for portal containers, theme observers).
 * We isolate the JSDOM into its own VM context and discard it after
 * introspection. If a bundle synchronously throws, we surface the error;
 * if it asynchronously schedules timers/observers, JSDOM cleanup tears
 * those down.
 */
import { JSDOM, VirtualConsole } from 'jsdom';
import { readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  BundleIntrospectionResult,
  BundleExport,
  ExtractorInputs,
} from './types.js';

const COMPONENT_NAME_RE = /^[A-Z][A-Za-z0-9_]*$/;
const HOOK_NAME_RE = /^use[A-Z][A-Za-z0-9_]*$/;

export interface IntrospectBundleOptions {
  bundlePath: string;
  nodeModulesDir: string;
  /**
   * Optional list of package names whose exports we should match against
   * window.Beaver to resolve `name → package` mappings. If omitted, the
   * function reads `apps/beaver-runtime/package.json` and uses its
   * `dependencies`.
   */
  runtimeDeps?: string[];
  /**
   * Optional path to apps/beaver-runtime/package.json. Used to discover
   * runtimeDeps if not given explicitly.
   */
  runtimePackageJson?: string;
}

export async function introspectBundle(
  options: IntrospectBundleOptions,
): Promise<BundleIntrospectionResult> {
  const bundleSource = await readFile(options.bundlePath, 'utf8');

  const beaverRuntime = await loadBundleInJsdom(bundleSource);

  const exports: BundleExport[] = [];
  const tokenGroups: string[] = [];

  for (const name of Object.keys(beaverRuntime)) {
    if (name === 'tokens') continue; // handled separately below
    exports.push(classifyExport(name, beaverRuntime[name]));
  }

  // tokens namespace: { color: {...}, spacing: {...}, ... }
  const tokensNs = (beaverRuntime as { tokens?: Record<string, unknown> }).tokens;
  if (tokensNs && typeof tokensNs === 'object') {
    for (const groupName of Object.keys(tokensNs)) {
      tokenGroups.push(groupName);
    }
  }

  const packageOf = await resolvePackagesForExports(
    exports.map((e) => e.name),
    options,
  );

  return { exports, tokenGroups, packageOf };
}

/**
 * Load the UMD bundle in a sandboxed JSDOM and return whatever it
 * assigned to `window.Beaver`. Throws if React/ReactDOM stubs aren't
 * provided (the bundle expects them as externals).
 */
async function loadBundleInJsdom(
  bundleSource: string,
): Promise<Record<string, unknown>> {
  const virtualConsole = new VirtualConsole();
  // Suppress JSDOM's default error printing; we'll surface real errors via
  // exceptions instead.
  virtualConsole.on('error', () => {});
  virtualConsole.on('jsdomError', () => {});

  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole,
    url: 'http://localhost/',
  });

  // Inject minimal React + ReactDOM stubs so the UMD wrapper can resolve
  // the `react` / `react-dom` globals it expects. We don't actually need
  // React to do anything; the bundle's IIFE assigns `window.Beaver` and we
  // read it. If a Beaver component eagerly calls React.createContext() at
  // module load, the stub provides a no-op.
  const reactStub = makeReactStub();
  Object.assign(dom.window, {
    React: reactStub,
    ReactDOM: makeReactDomStub(),
    'react/jsx-runtime': makeJsxRuntimeStub(reactStub),
  });

  const scriptEl = dom.window.document.createElement('script');
  scriptEl.textContent = bundleSource;

  try {
    dom.window.document.body.appendChild(scriptEl);
  } catch (err) {
    dom.window.close();
    throw new Error(
      `Bundle threw during load in JSDOM: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const beaver = (dom.window as unknown as { Beaver?: Record<string, unknown> }).Beaver;
  if (!beaver || typeof beaver !== 'object') {
    dom.window.close();
    throw new Error(
      'Bundle did not assign window.Beaver. Check apps/beaver-runtime/vite.config.ts (name: "Beaver", format: "umd").',
    );
  }

  // Snapshot keys before tearing down JSDOM (the proxy-window won't be
  // valid after close()).
  const snapshot: Record<string, unknown> = {};
  for (const k of Object.keys(beaver)) {
    snapshot[k] = beaver[k];
  }
  dom.window.close();
  return snapshot;
}

function makeReactStub(): Record<string, unknown> {
  const noop = () => undefined;
  const createContext = () => ({
    Provider: noop,
    Consumer: noop,
    displayName: '',
  });
  return {
    createContext,
    forwardRef: (fn: unknown) => fn,
    memo: (fn: unknown) => fn,
    createElement: noop,
    Fragment: Symbol.for('react.fragment'),
    useState: () => [undefined, noop],
    useEffect: noop,
    useRef: () => ({ current: null }),
    useMemo: (fn: () => unknown) => {
      try {
        return fn();
      } catch {
        return undefined;
      }
    },
    useCallback: (fn: unknown) => fn,
    useContext: noop,
    useReducer: () => [undefined, noop],
    useImperativeHandle: noop,
    useLayoutEffect: noop,
    useDebugValue: noop,
    useId: () => 'jsdom-id',
    Children: { map: noop, forEach: noop, count: () => 0, toArray: () => [], only: noop },
  };
}

function makeReactDomStub(): Record<string, unknown> {
  const noop = () => undefined;
  return {
    render: noop,
    createRoot: () => ({ render: noop, unmount: noop }),
    createPortal: (child: unknown) => child,
    flushSync: (fn: () => unknown) => {
      try {
        return fn();
      } catch {
        return undefined;
      }
    },
  };
}

function makeJsxRuntimeStub(reactStub: Record<string, unknown>): Record<string, unknown> {
  const noop = () => undefined;
  return {
    jsx: noop,
    jsxs: noop,
    Fragment: reactStub.Fragment,
  };
}

function classifyExport(name: string, value: unknown): BundleExport {
  const typeOf = typeof value as BundleExport['typeOf'];
  let classification: BundleExport['classification'] = 'unknown';

  if (typeOf === 'function') {
    if (HOOK_NAME_RE.test(name)) classification = 'hook';
    else if (COMPONENT_NAME_RE.test(name)) classification = 'component';
    else classification = 'utility';
  } else if (typeOf === 'object' && value !== null) {
    classification = 'utility';
  }

  return { name, typeOf, classification };
}

/**
 * For each export name, try to find which Beaver-runtime dependency
 * package it came from. We do this by dynamically `require`-ing each
 * dep package, reading its top-level exports, and matching by name.
 *
 * This is best-effort: a name may be re-exported from multiple packages
 * (the barrel `@beaver-ui/components` re-exports from all sub-packages).
 * We prefer the most specific package — the one whose name is NOT the
 * barrel, when both match.
 */
async function resolvePackagesForExports(
  names: string[],
  options: IntrospectBundleOptions,
): Promise<Record<string, string>> {
  const deps = options.runtimeDeps
    ? options.runtimeDeps
    : await readRuntimeDepsFromPackageJson(options);

  const out: Record<string, string> = {};
  // Map of barrel candidates we found; we use them only when no
  // sub-package claims a name.
  const fromBarrel: Record<string, string> = {};

  for (const dep of deps) {
    const isBarrel = looksLikeBarrelPackage(dep);
    let depExports: string[] = [];
    try {
      depExports = await readExportsForPackage(dep, options.nodeModulesDir);
    } catch {
      continue; // this dep doesn't resolve cleanly, skip
    }
    for (const name of depExports) {
      if (!names.includes(name)) continue;
      if (isBarrel) {
        if (!(name in fromBarrel)) fromBarrel[name] = dep;
      } else {
        // Prefer the first non-barrel match.
        if (!(name in out)) out[name] = dep;
      }
    }
  }

  // Fill in barrel attributions for names with no sub-package claim.
  for (const [name, dep] of Object.entries(fromBarrel)) {
    if (!(name in out)) out[name] = dep;
  }

  return out;
}

function looksLikeBarrelPackage(dep: string): boolean {
  // Heuristic: the public barrel of a DS scope tends to be named
  // `<scope>/components` or just `<scope>`.
  return /\/components$/.test(dep) || !dep.includes('/', dep.indexOf('/') + 1);
}

async function readRuntimeDepsFromPackageJson(
  options: IntrospectBundleOptions,
): Promise<string[]> {
  const pj = options.runtimePackageJson;
  if (!pj) return [];
  try {
    const content = await readFile(pj, 'utf8');
    const parsed = JSON.parse(content) as { dependencies?: Record<string, string> };
    return Object.keys(parsed.dependencies ?? {}).filter((name) =>
      // Only DS-scope dependencies, exclude react / react-dom etc.
      name.startsWith('@'),
    );
  } catch {
    return [];
  }
}

async function readExportsForPackage(
  pkg: string,
  nodeModulesDir: string,
): Promise<string[]> {
  // Resolve the package's main entry. We try a few common shapes:
  //   1) Read package.json's "module" / "main" → join with package dir.
  //   2) Try reading dist/index.js or dist/index.mjs.
  //   3) Fall back to reading dist/index.d.ts and parsing `export const`.
  //
  // The cheapest accurate path is dynamic `require()` because Node will
  // honour the exports map. We use `import()` (ESM-friendly) inside a
  // try/catch and fall through to .d.ts parsing if it doesn't work in this
  // environment.
  const pkgDir = join(nodeModulesDir, ...pkg.split('/'));

  // Try Object.keys on the resolved module first.
  try {
    const mod = await dynamicImport(pkg);
    if (mod && typeof mod === 'object') {
      const keys = Object.keys(mod).filter((k) => k !== 'default');
      if (keys.length > 0) return keys;
      // Some UMD/CJS interop wraps everything under `default`.
      const defaultExport = (mod as { default?: unknown }).default;
      if (defaultExport && typeof defaultExport === 'object') {
        return Object.keys(defaultExport);
      }
    }
  } catch {
    // fall through
  }

  // Fall back: parse dist/index.d.ts.
  for (const candidate of [
    'dist/index.d.ts',
    'dist/index.d.mts',
    'dist/index.js',
    'dist/index.mjs',
    'index.d.ts',
    'index.js',
  ]) {
    const file = join(pkgDir, candidate);
    try {
      await access(file);
      const src = await readFile(file, 'utf8');
      return parseExportNames(src);
    } catch {
      // try next
    }
  }
  return [];
}

async function dynamicImport(spec: string): Promise<unknown> {
  // Helper isolated in a function so `import()` doesn't get inlined into
  // a static import by bundlers when the extractor itself is bundled.
  return import(spec);
}

function parseExportNames(src: string): string[] {
  const names = new Set<string>();
  // export const Foo = / export function Foo / export class Foo
  for (const m of src.matchAll(
    /export\s+(?:const|let|var|function|class|interface|type|enum)\s+([A-Z_][A-Za-z0-9_]*)/g,
  )) {
    names.add(m[1]!);
  }
  // export { Foo, Bar as Baz }
  for (const m of src.matchAll(/export\s*\{\s*([^}]+)\s*}/g)) {
    for (const part of m[1]!.split(',')) {
      const trimmed = part.trim();
      const renamed = /^([A-Za-z_$][\w$]*)\s+as\s+([A-Z_][\w$]*)$/.exec(trimmed);
      if (renamed) {
        names.add(renamed[2]!);
        continue;
      }
      const direct = /^([A-Z_][\w$]*)$/.exec(trimmed);
      if (direct) names.add(direct[1]!);
    }
  }
  // export { default as Foo } from '...'
  for (const m of src.matchAll(
    /export\s*\{\s*default\s+as\s+([A-Z_][\w$]*)\s*}\s*from/g,
  )) {
    names.add(m[1]!);
  }
  return [...names];
}
