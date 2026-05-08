/**
 * introspect-bundle.ts — phase 1 of beaver:sync.
 *
 * Loads the built UMD bundle (`apps/beaver-runtime/dist/beaver.umd.js`) in
 * a sandboxed environment (JSDOM by default; Playwright optional), reads
 * `Object.keys(window.Beaver)`, classifies each exported name
 * (component / hook / utility / tokens-namespace), and resolves each
 * name back to its source package by side-channel — dynamically loading
 * each Beaver / inner-DS package from node_modules and matching its
 * exported names.
 *
 * Why this approach: the bundle is the single source of truth about what
 * is *actually* available at preview time. Parsing source trees or stories
 * is error-prone (sub-components in separate files, hybrid story formats,
 * non-standard prop names). The bundle either exports a name or it
 * doesn't; this avoids the false-positives we hit in v1.
 *
 * Two introspectors are supported:
 *
 *   1. JSDOM (default, in-process). Fast (~200 ms cold). Provides a full
 *      React/ReactDOM/jsx-runtime stub plus DOM-API polyfills
 *      (ResizeObserver, IntersectionObserver, matchMedia, rAF) so a
 *      typical DS bundle's eager init code runs without throwing. Errors
 *      from script execution are *collected*, not silently swallowed —
 *      if window.Beaver ends up empty, the collected errors are part of
 *      the thrown exception, which is critical for diagnosing why init
 *      failed.
 *
 *   2. Playwright (opt-in). Loads the bundle in a real headless Chromium.
 *      Slower (~2-5 s cold) but completely real DOM/runtime — useful when
 *      the bundle uses an API JSDOM doesn't emulate (CSS.supports edge
 *      cases, Web Components, IntersectionObserver tracking actual
 *      layout, etc.). Activate via `runIntrospector('playwright', …)`.
 *
 * Both introspectors return the same shape so the rest of the pipeline
 * (extract-props, sync) doesn't care which was used.
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

export type IntrospectorKind = 'jsdom' | 'playwright';

export interface IntrospectBundleOptions {
  bundlePath: string;
  nodeModulesDir: string;
  /**
   * Which introspector to use. Defaults to 'jsdom'. Set to 'playwright'
   * when JSDOM stubs aren't sufficient (use case: a Beaver/inner-DS
   * component eagerly calls a browser API JSDOM doesn't emulate).
   */
  introspector?: IntrospectorKind;
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

  const introspector = options.introspector ?? 'jsdom';
  const loaded =
    introspector === 'playwright'
      ? await loadBundleInPlaywright(bundleSource)
      : await loadBundleInJsdom(bundleSource);

  const exports: BundleExport[] = [];
  const tokenGroups: string[] = [];

  for (const name of Object.keys(loaded.beaver)) {
    if (name === 'tokens') continue; // handled separately below
    exports.push(classifyExport(name, loaded.beaver[name]));
  }

  // tokens namespace: { color: {...}, spacing: {...}, ... }
  const tokensNs = (loaded.beaver as { tokens?: Record<string, unknown> }).tokens;
  if (tokensNs && typeof tokensNs === 'object') {
    for (const groupName of Object.keys(tokensNs)) {
      tokenGroups.push(groupName);
    }
  }

  const packageOf = await resolvePackagesForExports(
    exports.map((e) => e.name),
    options,
  );

  // Sanity warning: if the bundle's component count looks suspiciously
  // low compared to the number of dependencies the runtime declares,
  // print a hint to stderr. Most likely cause is that
  // `apps/beaver-runtime/src/index.ts` is missing inner-DS re-exports
  // (placeholder commented out from initial scaffold) — see
  // REMOTE-FIX-QUEUE.md #6.
  const componentCount = exports.filter(
    (e) => e.classification === 'component',
  ).length;
  if (componentCount > 0 && componentCount < 200) {
    const depCount = await countRuntimeDeps(options).catch(() => 0);
    if (depCount >= 20) {
      process.stderr.write(
        `[introspect-bundle] warning: ${componentCount} components found, ` +
          `but the runtime has ${depCount} declared deps. The bundle may be ` +
          `missing inner-DS re-exports. Check apps/beaver-runtime/src/index.ts — ` +
          `it should have \`export * from '<inner-scope>/components'\` (or ` +
          `equivalent per-package re-exports) for the inner DS.\n`,
      );
    }
  }

  return { exports, tokenGroups, packageOf };
}

async function countRuntimeDeps(
  options: IntrospectBundleOptions,
): Promise<number> {
  if (options.runtimeDeps) return options.runtimeDeps.length;
  if (!options.runtimePackageJson) return 0;
  const content = await readFile(options.runtimePackageJson, 'utf8');
  const parsed = JSON.parse(content) as { dependencies?: Record<string, string> };
  return Object.keys(parsed.dependencies ?? {}).filter((n) => n.startsWith('@'))
    .length;
}

/** Internal: shared output shape between introspector implementations. */
interface BundleLoadResult {
  beaver: Record<string, unknown>;
  /** Errors observed during script execution (collected, not thrown). */
  errors: string[];
}

/**
 * Load the UMD bundle in a sandboxed JSDOM and return whatever it
 * assigned to `window.Beaver`.
 *
 * Critical design points (these are what fixed remote-fix-queue #1):
 *
 *   1. Errors are collected, not silently suppressed. If `window.Beaver`
 *      ends up empty, those errors are part of the thrown exception. This
 *      is essential for diagnosing why a real Beaver bundle fails in
 *      JSDOM (the previous version swallowed errors and returned an
 *      empty object, which looked indistinguishable from "no exports").
 *   2. The React stub covers everything React 18 ships, including the
 *      pieces that DS components commonly call at module-init time
 *      (`createContext`, `forwardRef`, `memo`, `Suspense`, `lazy`,
 *      `cloneElement`, `isValidElement`, `Children`, `version`,
 *      `useTransition`, `useDeferredValue`, `useSyncExternalStore`,
 *      `useInsertionEffect`).
 *   3. ReactDOM and `react/jsx-runtime` stubs cover what a UMD bundle
 *      typically expects.
 *   4. JSDOM does not implement ResizeObserver, IntersectionObserver,
 *      MutationObserver-edge-cases, or matchMedia by default. We polyfill
 *      these as no-ops so component-init code that wires observers
 *      doesn't throw.
 *   5. `process.env.NODE_ENV = 'production'` is set on the JSDOM window,
 *      because some bundles do `if (process.env.NODE_ENV !== 'production')`
 *      checks at module top-level and JSDOM doesn't have a `process`
 *      global.
 */
async function loadBundleInJsdom(
  bundleSource: string,
): Promise<BundleLoadResult> {
  const errors: string[] = [];

  const virtualConsole = new VirtualConsole();
  // Collect, don't suppress. JSDOM's `error` event fires on uncaught
  // script errors; `jsdomError` fires for JSDOM-internal issues. Both
  // are diagnostic gold when the bundle won't load.
  virtualConsole.on('error', (err: Error) => {
    errors.push(`[jsdom error] ${err && (err.stack || err.message) ? err.stack || err.message : String(err)}`);
  });
  virtualConsole.on('jsdomError', (err: Error) => {
    errors.push(`[jsdomError] ${err && (err.stack || err.message) ? err.stack || err.message : String(err)}`);
  });
  // Suppress noisy `warn` / `log` so they don't pollute stderr; we don't
  // need them for diagnostics.

  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole,
    url: 'http://localhost/',
  });

  // Stubs and polyfills go on the JSDOM window BEFORE the script runs.
  installStubsAndPolyfills(dom.window, errors);

  const scriptEl = dom.window.document.createElement('script');
  scriptEl.textContent = bundleSource;

  try {
    dom.window.document.body.appendChild(scriptEl);
  } catch (err) {
    errors.push(
      `[appendChild threw] ${err instanceof Error ? err.stack || err.message : String(err)}`,
    );
  }

  const beaver = (dom.window as unknown as { Beaver?: Record<string, unknown> }).Beaver;

  // Snapshot keys before tearing down JSDOM (the proxy-window won't be
  // valid after close()).
  let snapshot: Record<string, unknown> = {};
  if (beaver && typeof beaver === 'object') {
    for (const k of Object.keys(beaver)) {
      snapshot[k] = beaver[k];
    }
  }

  dom.window.close();

  if (!beaver || typeof beaver !== 'object') {
    throw new Error(
      buildLoadFailureMessage(
        'Bundle did not assign window.Beaver. Check apps/beaver-runtime/vite.config.ts (name: "Beaver", format: "umd").',
        errors,
        bundleSource,
      ),
    );
  }

  if (Object.keys(snapshot).length === 0) {
    throw new Error(
      buildLoadFailureMessage(
        'Bundle assigned window.Beaver but it is empty. The UMD factory likely threw partway through; see collected errors below. Try `--introspector playwright` if JSDOM stubs are insufficient.',
        errors,
        bundleSource,
      ),
    );
  }

  return { beaver: snapshot, errors };
}

/**
 * Compose a multi-line error message that includes the high-level
 * symptom, any errors we collected from JSDOM/Playwright during script
 * execution, and (when the error has a parseable line:col) a slice of
 * the bundle source around the throw site. This is the difference
 * between "Bundle didn't load (?)" and a useful diagnostic.
 *
 * For minified bundles, the source slice still helps — even ±200
 * chars of minified output usually contains enough surrounding
 * identifiers to recognize the pattern (e.g. `class N extends ` plus
 * an undefined identifier).
 */
function buildLoadFailureMessage(
  symptom: string,
  errors: string[],
  bundleSource?: string,
): string {
  if (errors.length === 0) {
    return `${symptom}\n\n(no errors were observed by JSDOM during script execution; the factory may have early-returned silently)`;
  }
  const lines = [
    symptom,
    '',
    `Errors observed during script execution (${errors.length}):`,
    ...errors.map((e, i) => `  ${i + 1}. ${e}`),
  ];

  // Try to extract a (line:col) location from the first error and slice
  // ±200 chars of the bundle source around it. Even on minified bundles,
  // 400 chars usually contains enough surrounding identifiers to
  // recognise the pattern (e.g. "class N extends " followed by an
  // undefined identifier).
  if (bundleSource) {
    const slice = sliceBundleAtFirstErrorLocation(errors, bundleSource);
    if (slice) {
      lines.push('');
      lines.push('Bundle source context around the first error:');
      lines.push('```');
      lines.push(slice);
      lines.push('```');
      lines.push('');
      lines.push(
        'For a non-minified bundle (easier to read context, full identifiers, real line numbers), set BEAVER_DEBUG_BUILD=1 before re-running:',
      );
      lines.push('  BEAVER_DEBUG_BUILD=1 pnpm beaver:build-runtime');
      lines.push('  pnpm beaver:sync');
    }
  }

  return lines.join('\n');
}

function sliceBundleAtFirstErrorLocation(
  errors: string[],
  bundleSource: string,
): string | null {
  // Common error formats:
  //   "TypeError: ... at <anonymous>:51:18633"
  //   "    at <anonymous> (eval at ...:51:18633)"
  //   "...:LINE:COL"
  // Just grab the first (LINE:COL) tuple we find.
  for (const e of errors) {
    const m = /(\d+):(\d+)/.exec(e);
    if (!m) continue;
    const line = parseInt(m[1] ?? '0', 10);
    const col = parseInt(m[2] ?? '0', 10);
    if (!Number.isFinite(line) || !Number.isFinite(col) || line < 1) continue;

    // Convert (line, col) to absolute byte offset in source.
    const sourceLines = bundleSource.split('\n');
    if (line > sourceLines.length) continue;
    let offset = 0;
    for (let i = 0; i < line - 1; i += 1) {
      offset += (sourceLines[i] ?? '').length + 1; // +1 for newline
    }
    offset += col;

    const start = Math.max(0, offset - 200);
    const end = Math.min(bundleSource.length, offset + 200);
    const before = bundleSource.slice(start, offset);
    const after = bundleSource.slice(offset, end);
    // Mark the position with ⟨HERE⟩ so the local agent sees the exact
    // point even when it's mid-token.
    return `${before}⟨HERE⟩${after}`;
  }
  return null;
}

/**
 * Install React / ReactDOM / jsx-runtime stubs and DOM API polyfills on
 * the JSDOM window. Bundle init code can call any of these.
 */
function installStubsAndPolyfills(
  win: JSDOM['window'],
  _errors: string[],
): void {
  const reactStub = makeReactStub();
  // The UMD factory in our Vite config receives globals as
  // `(z.jsxRuntime, z.React, z.ReactDOM)` — see Beaver bundle prelude.
  // Both spellings are exposed.
  Object.assign(win, {
    React: reactStub,
    ReactDOM: makeReactDomStub(),
    jsxRuntime: makeJsxRuntimeStub(reactStub),
    // Some bundlers also probe `react` / `react-dom` namespaces directly:
    react: reactStub,
    'react-dom': makeReactDomStub(),
    'react/jsx-runtime': makeJsxRuntimeStub(reactStub),
  });

  // process.env probe — some bundles do `process.env.NODE_ENV` at top.
  // JSDOM has no `process` global by default.
  if (typeof (win as unknown as { process?: unknown }).process === 'undefined') {
    Object.assign(win, { process: { env: { NODE_ENV: 'production' } } });
  }

  // DOM Observer polyfills. JSDOM doesn't implement these; bundles that
  // wire e.g. ResizeObserver in module-init code throw.
  installObserverPolyfills(win);

  // matchMedia polyfill — many DS components query
  // `window.matchMedia('(prefers-...)')` in module-init code.
  if (typeof win.matchMedia !== 'function') {
    Object.assign(win, {
      matchMedia: (query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => undefined,
        removeListener: () => undefined,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        dispatchEvent: () => false,
      }),
    });
  }

  // requestAnimationFrame / cancelAnimationFrame — JSDOM has these but
  // be defensive.
  if (typeof win.requestAnimationFrame !== 'function') {
    Object.assign(win, {
      requestAnimationFrame: (cb: (t: number) => void) =>
        setTimeout(() => cb(Date.now()), 16) as unknown as number,
      cancelAnimationFrame: (id: number) => clearTimeout(id),
    });
  }

  // queueMicrotask — defensive.
  if (typeof win.queueMicrotask !== 'function') {
    Object.assign(win, {
      queueMicrotask: (cb: () => void) => Promise.resolve().then(cb),
    });
  }

  // CSS.supports stub — JSDOM has CSS but supports() may not return what
  // a bundle expects. Default to `true` for "is feature available?" gates.
  if (win.CSS && typeof win.CSS.supports !== 'function') {
    Object.assign(win.CSS, { supports: () => true });
  }
}

function installObserverPolyfills(win: JSDOM['window']): void {
  class ResizeObserverPolyfill {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  class IntersectionObserverPolyfill {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
    takeRecords(): unknown[] {
      return [];
    }
  }
  if (typeof (win as unknown as { ResizeObserver?: unknown }).ResizeObserver === 'undefined') {
    Object.assign(win, { ResizeObserver: ResizeObserverPolyfill });
  }
  if (
    typeof (win as unknown as { IntersectionObserver?: unknown }).IntersectionObserver ===
    'undefined'
  ) {
    Object.assign(win, { IntersectionObserver: IntersectionObserverPolyfill });
  }
}

function makeReactStub(): Record<string, unknown> {
  const noop = () => undefined;
  const identity = <T>(x: T): T => x;
  const createContext = (defaultValue?: unknown) => {
    const ctx = {
      Provider: ((props: { children?: unknown }) => props.children) as unknown,
      Consumer: ((props: { children?: (v: unknown) => unknown }) =>
        typeof props.children === 'function' ? props.children(defaultValue) : null) as unknown,
      displayName: '',
      _currentValue: defaultValue,
    };
    return ctx;
  };
  const forwardRef = (render: unknown) => {
    // Return a callable that exposes $$typeof so isValidElement/etc don't
    // crash. The actual render isn't invoked during introspection.
    const fn = (props: unknown, ref: unknown) =>
      typeof render === 'function' ? (render as (p: unknown, r: unknown) => unknown)(props, ref) : null;
    Object.assign(fn, { $$typeof: Symbol.for('react.forward_ref'), render });
    return fn;
  };
  const memo = (component: unknown) => {
    const wrapped = (props: unknown) =>
      typeof component === 'function' ? (component as (p: unknown) => unknown)(props) : null;
    Object.assign(wrapped, { $$typeof: Symbol.for('react.memo'), type: component });
    return wrapped;
  };
  const lazy = (factory: () => Promise<unknown>) => {
    const obj = { $$typeof: Symbol.for('react.lazy'), _ctor: factory };
    return obj;
  };

  // Class component bases. CRITICAL: REMOTE-FIX-QUEUE.md #9 was caused by
  // these missing — when a Beaver/inner-DS component does
  // `class Foo extends React.Component {}` (or PureComponent), an absent
  // base class throws "Class extends value undefined is not a constructor
  // or null" at module-init time, before window.Beaver assignment
  // completes. Provide minimal class implementations.
  class Component {
    public props: unknown;
    public state: unknown;
    public context: unknown;
    public refs: unknown;
    public updater: unknown;
    constructor(props?: unknown, context?: unknown) {
      this.props = props;
      this.context = context;
      this.refs = {};
      this.state = {};
      this.updater = null;
    }
    setState(): void {}
    forceUpdate(): void {}
    render(): unknown {
      return null;
    }
  }
  class PureComponent extends Component {}

  return {
    version: '18.3.1',
    createContext,
    createRef: () => ({ current: null }),
    createElement: noop,
    cloneElement: noop,
    isValidElement: () => false,
    forwardRef,
    memo,
    lazy,
    Component,
    PureComponent,
    Fragment: Symbol.for('react.fragment'),
    StrictMode: Symbol.for('react.strict_mode'),
    Suspense: Symbol.for('react.suspense'),
    Profiler: Symbol.for('react.profiler'),
    // Hooks
    useState: <T>(initial: T | (() => T)) => [
      typeof initial === 'function' ? (initial as () => T)() : initial,
      noop,
    ],
    useEffect: noop,
    useLayoutEffect: noop,
    useInsertionEffect: noop,
    useRef: <T>(initial: T) => ({ current: initial }),
    useMemo: <T>(fn: () => T) => {
      try {
        return fn();
      } catch {
        return undefined as unknown as T;
      }
    },
    useCallback: identity,
    useContext: (ctx: { _currentValue?: unknown }) => ctx?._currentValue,
    useReducer: <S>(_r: unknown, init: S) => [init, noop],
    useImperativeHandle: noop,
    useDebugValue: noop,
    useId: () => `:r0:`,
    useTransition: () => [false, (cb: () => void) => cb()],
    useDeferredValue: identity,
    useSyncExternalStore: <T>(_subscribe: unknown, getSnapshot: () => T) => {
      try {
        return getSnapshot();
      } catch {
        return undefined as unknown as T;
      }
    },
    startTransition: (cb: () => void) => cb(),
    Children: {
      map: <T>(_c: T, _fn: unknown) => [],
      forEach: noop,
      count: () => 0,
      toArray: () => [],
      only: identity,
    },
    // Internals some libraries probe at module init.
    __SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED: {
      ReactCurrentDispatcher: { current: null },
      ReactCurrentBatchConfig: { transition: null },
      ReactCurrentOwner: { current: null },
    },
  };
}

function makeReactDomStub(): Record<string, unknown> {
  const noop = () => undefined;
  return {
    version: '18.3.1',
    render: noop,
    hydrate: noop,
    createRoot: () => ({ render: noop, unmount: noop }),
    hydrateRoot: () => ({ render: noop, unmount: noop }),
    createPortal: (child: unknown) => child,
    flushSync: <T>(fn: () => T): T | undefined => {
      try {
        return fn();
      } catch {
        return undefined;
      }
    },
    findDOMNode: () => null,
    unmountComponentAtNode: () => false,
  };
}

function makeJsxRuntimeStub(
  reactStub: Record<string, unknown>,
): Record<string, unknown> {
  const noop = () => undefined;
  return {
    jsx: noop,
    jsxs: noop,
    jsxDEV: noop,
    Fragment: reactStub.Fragment,
  };
}

/**
 * Playwright introspector — opt-in via `introspector: 'playwright'`.
 *
 * Loads the bundle in a real headless Chromium, so any DOM/runtime API
 * the bundle assumes works as it would in the iframe preview. Useful
 * when JSDOM stubs aren't sufficient (Web Components, complex DOM
 * matrix operations, real CSS computation, etc.).
 *
 * Cost: ~2-5 s cold start (Chromium spawn). For a one-shot
 * `pnpm beaver:sync` run, fine.
 *
 * Implementation note: Playwright is loaded dynamically. If
 * `playwright` isn't installed, the introspector throws a clear
 * "install playwright" error rather than failing at import time. This
 * keeps Playwright as an optional peer dep — JSDOM users don't pay the
 * 200+ MB Chromium download cost.
 */
async function loadBundleInPlaywright(
  bundleSource: string,
): Promise<BundleLoadResult> {
  let chromium: { launch(opts?: unknown): Promise<unknown> };
  try {
    const mod = (await import('playwright')) as unknown as {
      chromium?: { launch(opts?: unknown): Promise<unknown> };
    };
    if (!mod.chromium) {
      throw new Error('playwright module did not export `chromium`');
    }
    chromium = mod.chromium;
  } catch (err) {
    throw new Error(
      `Playwright introspector requested but 'playwright' is not installed. ` +
        `Install with 'pnpm add -D -w playwright && pnpm exec playwright install chromium', ` +
        `or use the default JSDOM introspector. Underlying error: ${
          err instanceof Error ? err.message : String(err)
        }`,
    );
  }

  const errors: string[] = [];
  const browser = (await chromium.launch({ headless: true })) as {
    newContext(): Promise<unknown>;
    close(): Promise<void>;
  };
  try {
    const context = (await browser.newContext()) as {
      newPage(): Promise<unknown>;
    };
    const page = (await context.newPage()) as {
      on(event: string, cb: (...args: unknown[]) => void): unknown;
      setContent(html: string, opts?: unknown): Promise<unknown>;
      addScriptTag(opts: { content: string }): Promise<unknown>;
      evaluate<T>(fn: () => T): Promise<T>;
    };

    page.on('pageerror', (err: unknown) => {
      const e = err as Error;
      errors.push(`[pageerror] ${e?.stack ?? e?.message ?? String(err)}`);
    });
    page.on('console', (msg: unknown) => {
      const m = msg as { type(): string; text(): string };
      if (m.type() === 'error') errors.push(`[console.error] ${m.text()}`);
    });

    // Install React stubs as window globals BEFORE running the bundle.
    const stubScript = `
      (function(){
        var noop = function(){ return undefined; };
        ${makeBrowserStubsBoot()}
      })();
    `;
    await page.setContent('<!doctype html><html><head></head><body></body></html>');
    await page.addScriptTag({ content: stubScript });
    await page.addScriptTag({ content: bundleSource });

    const result = await page.evaluate<{
      keys: string[];
      data: Record<string, unknown>;
      tokenGroupNames: string[];
    }>(() => {
      const w = window as unknown as { Beaver?: Record<string, unknown> };
      const beaver = w.Beaver ?? {};
      const keys = Object.keys(beaver);
      const data: Record<string, unknown> = {};
      let tokenGroupNames: string[] = [];
      for (const k of keys) {
        const v = (beaver as Record<string, unknown>)[k];
        // Function/object instances can't cross the worker boundary in a
        // way that preserves their identity; we only need typeof for
        // classification downstream, so serialize a tag instead.
        if (typeof v === 'function') {
          data[k] = '__function__';
        } else if (v === null) {
          data[k] = null;
        } else if (typeof v === 'object') {
          // Special-case the tokens namespace: capture its group keys so
          // the caller can reconstruct it for tokenGroups population.
          if (k === 'tokens') {
            tokenGroupNames = Object.keys(v as Record<string, unknown>);
          }
          data[k] = '__object__';
        } else {
          data[k] = v;
        }
      }
      return { keys, data, tokenGroupNames };
    });

    if (result.keys.length === 0) {
      throw new Error(
        buildLoadFailureMessage(
          'Bundle assigned window.Beaver but it is empty (Playwright introspector). The UMD factory likely threw partway through.',
          errors,
          bundleSource,
        ),
      );
    }

    const beaver: Record<string, unknown> = {};
    for (const k of result.keys) {
      const tag = result.data[k];
      if (tag === '__function__') {
        beaver[k] = () => undefined;
      } else if (tag === '__object__') {
        // Reconstruct tokens namespace as a real object with its group
        // keys, so the caller's `Object.keys(beaver.tokens)` returns the
        // group names. Other object-tagged exports are kept as empty
        // objects (we don't introspect their inner structure here; the
        // value isn't used downstream — only the typeof for classification).
        if (k === 'tokens') {
          const tokensObj: Record<string, unknown> = {};
          for (const groupName of result.tokenGroupNames) {
            tokensObj[groupName] = {};
          }
          beaver[k] = tokensObj;
        } else {
          beaver[k] = {};
        }
      } else {
        beaver[k] = tag;
      }
    }
    return { beaver, errors };
  } finally {
    await browser.close();
  }
}

/**
 * Stub script for Playwright. Same shape as JSDOM stubs but inlined as
 * source so we can ship it via `addScriptTag`. Kept in sync with
 * `installStubsAndPolyfills`.
 */
function makeBrowserStubsBoot(): string {
  return `
    var Sym = function(name){ try { return Symbol.for(name); } catch (_) { return name; } };
    var FRAG = Sym('react.fragment');
    var noop = function(){ return undefined; };
    var identity = function(x){ return x; };

    // Class component bases — see REMOTE-FIX-QUEUE.md #9. Without these,
    // any DS component using \`class Foo extends React.Component\` throws
    // "Class extends value undefined is not a constructor or null" at
    // module-init.
    function ReactComponent(props, context){
      this.props = props;
      this.context = context;
      this.refs = {};
      this.state = {};
      this.updater = null;
    }
    ReactComponent.prototype.setState = noop;
    ReactComponent.prototype.forceUpdate = noop;
    ReactComponent.prototype.render = function(){ return null; };
    function ReactPureComponent(){ ReactComponent.apply(this, arguments); }
    ReactPureComponent.prototype = Object.create(ReactComponent.prototype);
    ReactPureComponent.prototype.constructor = ReactPureComponent;

    var React = {
      version: '18.3.1',
      Component: ReactComponent,
      PureComponent: ReactPureComponent,
      createContext: function(d){ return { Provider: function(p){ return p && p.children; }, Consumer: function(p){ return typeof p?.children==='function' ? p.children(d) : null; }, displayName: '', _currentValue: d }; },
      createRef: function(){ return { current: null }; },
      createElement: noop,
      cloneElement: noop,
      isValidElement: function(){ return false; },
      forwardRef: function(render){ var fn = function(p,r){ return typeof render==='function' ? render(p,r) : null; }; fn.$$typeof = Sym('react.forward_ref'); fn.render = render; return fn; },
      memo: function(c){ var fn = function(p){ return typeof c==='function' ? c(p) : null; }; fn.$$typeof = Sym('react.memo'); fn.type = c; return fn; },
      lazy: function(f){ return { $$typeof: Sym('react.lazy'), _ctor: f }; },
      Fragment: FRAG,
      StrictMode: Sym('react.strict_mode'),
      Suspense: Sym('react.suspense'),
      Profiler: Sym('react.profiler'),
      useState: function(i){ return [typeof i==='function'? i(): i, noop]; },
      useEffect: noop, useLayoutEffect: noop, useInsertionEffect: noop,
      useRef: function(i){ return { current: i }; },
      useMemo: function(fn){ try { return fn(); } catch(_){ return undefined; } },
      useCallback: identity,
      useContext: function(c){ return c && c._currentValue; },
      useReducer: function(_r, i){ return [i, noop]; },
      useImperativeHandle: noop, useDebugValue: noop,
      useId: function(){ return ':r0:'; },
      useTransition: function(){ return [false, function(cb){ cb(); }]; },
      useDeferredValue: identity,
      useSyncExternalStore: function(_s, get){ try { return get(); } catch(_){ return undefined; } },
      startTransition: function(cb){ cb(); },
      Children: { map: function(){ return []; }, forEach: noop, count: function(){ return 0; }, toArray: function(){ return []; }, only: identity },
      __SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED: { ReactCurrentDispatcher: { current: null }, ReactCurrentBatchConfig: { transition: null }, ReactCurrentOwner: { current: null } }
    };
    var ReactDOM = {
      version: '18.3.1',
      render: noop, hydrate: noop,
      createRoot: function(){ return { render: noop, unmount: noop }; },
      hydrateRoot: function(){ return { render: noop, unmount: noop }; },
      createPortal: function(c){ return c; },
      flushSync: function(fn){ try { return fn(); } catch(_){ return undefined; } },
      findDOMNode: function(){ return null; }, unmountComponentAtNode: function(){ return false; }
    };
    var jsxRuntime = { jsx: noop, jsxs: noop, jsxDEV: noop, Fragment: FRAG };

    window.React = React; window.ReactDOM = ReactDOM; window.jsxRuntime = jsxRuntime;
    window['react'] = React; window['react-dom'] = ReactDOM; window['react/jsx-runtime'] = jsxRuntime;

    if (typeof window.process === 'undefined') window.process = { env: { NODE_ENV: 'production' } };

    if (!window.ResizeObserver) window.ResizeObserver = function(){ this.observe=noop; this.unobserve=noop; this.disconnect=noop; };
    if (!window.IntersectionObserver) window.IntersectionObserver = function(){ this.observe=noop; this.unobserve=noop; this.disconnect=noop; this.takeRecords=function(){return [];}; };
    if (!window.matchMedia) window.matchMedia = function(q){ return { matches: false, media: q, onchange: null, addListener: noop, removeListener: noop, addEventListener: noop, removeEventListener: noop, dispatchEvent: function(){ return false; } }; };
  `;
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
