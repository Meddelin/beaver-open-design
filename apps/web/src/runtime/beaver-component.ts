/**
 * Build a sandboxed iframe srcdoc that renders a Beaver UI prototype.
 *
 * v2 design: the iframe does NOT show errors to the user. Any failure
 * (Babel parse, runtime exception, missing component, missing import) is
 * forwarded to the parent window via `postMessage` with type
 * `od:beaver-runtime-error`. The web app's chat layer handles auto-correction
 * (sends the error back to the agent, hides the broken iframe behind the
 * "model is working" indicator, swaps in the new artifact when it lands).
 *
 * The user only sees iframes that successfully rendered. Anything in
 * between is hidden behind the same loading state as fresh generation.
 *
 * Code-side validation is intentionally minimal:
 *   - The Babel transform is the only "validator" that runs synchronously.
 *     Its purpose is parseability — without it nothing renders.
 *   - There is no import whitelist check, no manifest cross-check, no
 *     JSX-tag coverage check. If the LLM imported a nonexistent component,
 *     it'll throw at runtime ("Foo is not defined") and the auto-correction
 *     loop will pick that up. Code that tries to predict what the model
 *     should or shouldn't do gets in the way and creates false positives.
 *
 * Pipeline (in iframe):
 *   1. Pre-process TSX: rewrite `@beaver-ui/*` and `@<inner>/*` imports
 *      into `const { … } = window.Beaver(.tokens)?` destructurings.
 *   2. `prepareReactComponentSource` strips React imports and turns the
 *      default export into `window.__OpenDesignComponent`.
 *   3. Babel transforms TSX → JS with `presets: ['typescript', 'react']`.
 *   4. eval + ReactDOM.createRoot mount.
 *   5. Any failure at any step → postMessage to parent.
 */
import { prepareReactComponentSource } from './react-component';

interface BeaverComponentSrcdocOptions {
  title: string;
  /** Path or absolute URL to the Beaver runtime UMD. Defaults to `/vendor/beaver.umd.js`. */
  beaverRuntimeUrl?: string;
  /** Path or absolute URL to the Beaver runtime stylesheet. Defaults to `/vendor/beaver.css`. */
  beaverStylesheetUrl?: string;
  /**
   * Identifier the parent will see in postMessage events to correlate the
   * iframe instance with a chat / artifact run. Optional; if omitted, the
   * parent has to disambiguate by event source alone.
   */
  artifactId?: string;
}

const REACT_DEV_URL = 'https://unpkg.com/react@18.3.1/umd/react.development.js';
const REACT_DOM_DEV_URL =
  'https://unpkg.com/react-dom@18.3.1/umd/react-dom.development.js';
const BABEL_STANDALONE_URL =
  'https://unpkg.com/@babel/standalone@7.29.0/babel.min.js';

const BEAVER_RUNTIME_URL_DEFAULT = '/vendor/beaver.umd.js';
const BEAVER_STYLESHEET_URL_DEFAULT = '/vendor/beaver.css';

/**
 * Allowed import prefixes for the runtime rewriter. v2 keeps this list as a
 * runtime *resolver* concern (we need to know which destructure root to
 * use), not a *security* one — non-allowlisted imports are not rejected
 * here; they pass through to runtime where they fail with "is not defined".
 * That failure routes through the auto-correction loop.
 *
 * Inner-DS scope: replace `@inner-ds/` with the actual scope after
 * `pnpm install` resolves the Beaver dep graph. See AGENTS.md / README.
 */
const ALLOWED_IMPORT_PREFIXES = [
  '@beaver-ui/',
  '@inner-ds/',
] as const;

const TOKENS_PACKAGE_SUFFIX = '/design-tokens';

/**
 * @deprecated In v2 the runtime no longer rejects non-allowlisted imports
 * eagerly. Kept as an export so any old call site (e.g. tests) compiles;
 * remove after a follow-up cleanup pass.
 */
export class BeaverImportError extends Error {
  constructor(
    public readonly source: string,
    public readonly reason: string,
  ) {
    super(`Disallowed import in artifact: ${source} (${reason})`);
  }
}

/**
 * Postmessage event types emitted by the iframe to the parent.
 *
 *   od:beaver-runtime-ready    — bundle and React loaded, ready to render.
 *   od:beaver-runtime-error    — Babel parse / runtime exception. Parent
 *                                 should NOT show this to the user; it
 *                                 should forward to the agent loop as a
 *                                 correction request and keep the
 *                                 "generating" indicator visible.
 *   od:beaver-runtime-rendered — render succeeded. Parent reveals the
 *                                 iframe to the user.
 */
export const BEAVER_RUNTIME_READY = 'od:beaver-runtime-ready';
export const BEAVER_RUNTIME_ERROR = 'od:beaver-runtime-error';
export const BEAVER_RUNTIME_RENDERED = 'od:beaver-runtime-rendered';

export function buildBeaverComponentSrcdoc(
  source: string,
  options: BeaverComponentSrcdocOptions,
): string {
  // Pre-iframe TSX rewriting. If this throws, we still emit a valid HTML
  // doc — but with a script that immediately postMessages the error. We
  // never render an inline error UI; the parent handles user-facing UX.
  let prepared = '';
  let preMountError: { phase: string; message: string } | null = null;
  try {
    const rewritten = rewriteBeaverImports(source);
    prepared = prepareReactComponentSource(rewritten);
  } catch (err) {
    preMountError = {
      phase: 'pre-mount',
      message: err instanceof Error ? err.message : String(err),
    };
  }

  const safeTitle = escapeHtml(options.title || 'Beaver prototype');
  const beaverRuntimeUrl = options.beaverRuntimeUrl ?? BEAVER_RUNTIME_URL_DEFAULT;
  const beaverStylesheetUrl =
    options.beaverStylesheetUrl ?? BEAVER_STYLESHEET_URL_DEFAULT;
  const artifactIdJson = JSON.stringify(options.artifactId ?? null);
  const sourceJson = JSON.stringify(prepared);
  const preMountErrorJson = JSON.stringify(preMountError);
  const eventReady = JSON.stringify(BEAVER_RUNTIME_READY);
  const eventError = JSON.stringify(BEAVER_RUNTIME_ERROR);
  const eventRendered = JSON.stringify(BEAVER_RUNTIME_RENDERED);

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${safeTitle}</title>
    <link rel="stylesheet" href="${escapeAttr(beaverStylesheetUrl)}" />
    <style>
      :root { color-scheme: light; }
      * { box-sizing: border-box; }
      html, body, #root { min-height: 100%; margin: 0; }
      body { background: #fff; color: #111827; }
    </style>
  </head>
  <body>
    <div id="root"></div>
    <script src="${REACT_DEV_URL}"></script>
    <script src="${REACT_DOM_DEV_URL}"></script>
    <script src="${BABEL_STANDALONE_URL}"></script>
    <script src="${escapeAttr(beaverRuntimeUrl)}"></script>
    <script>
      (function(){
        var artifactId = ${artifactIdJson};
        var ROOT = document.getElementById('root');

        function post(type, payload) {
          try {
            var data = Object.assign({ type: type, artifactId: artifactId }, payload || {});
            window.parent.postMessage(data, '*');
          } catch (_) {}
        }

        function reportError(phase, err) {
          var message = (err && (err.message || err.toString())) || String(err);
          var stack = err && err.stack ? String(err.stack) : null;
          // Common runtime patterns we surface explicitly so the parent (or
          // the auto-correction prompt) has cleaner signal:
          //  - "X is not defined"            → likely missing import
          //  - "Cannot read properties of undefined" → likely wrong prop access
          //  - "Element type is invalid"     → undefined component in JSX
          var hint = null;
          var notDefined = /^([A-Z][A-Za-z0-9_]*) is not defined$/.exec(message);
          if (notDefined) {
            hint = {
              kind: 'missing-import',
              symbol: notDefined[1],
              suggestion: 'Component "' + notDefined[1] + '" is referenced in JSX but not imported (or not exported by any allowed package). Add an import or remove the reference.'
            };
          } else if (/Element type is invalid/.test(message)) {
            hint = { kind: 'invalid-element-type', suggestion: 'A JSX element resolved to undefined — usually a missing import or wrong destructuring.' };
          } else if (/Minified React error #130/.test(message)) {
            hint = { kind: 'invalid-element-type', suggestion: 'React received undefined as a component. Check imports and component names.' };
          } else if (/Unexpected token/.test(message) || /Missing semicolon/.test(message)) {
            hint = { kind: 'parse-error', suggestion: 'TSX failed to parse. Check template literals (must be inside backticks), unclosed JSX, missing parentheses.' };
          }
          post(${eventError}, { phase: phase, message: message, stack: stack, hint: hint });
        }

        // Pre-mount error from rewriteBeaverImports / prepareReactComponentSource —
        // surfaced before runtime even starts.
        var preMountError = ${preMountErrorJson};
        if (preMountError) {
          reportError(preMountError.phase, new Error(preMountError.message));
          return;
        }

        if (!window.React || !window.ReactDOM || !window.Babel) {
          reportError('runtime-load', new Error('React/ReactDOM/Babel UMD failed to load. Check network access from sandbox iframe.'));
          return;
        }
        if (!window.Beaver) {
          reportError('runtime-load', new Error('Beaver runtime not loaded at ${beaverRuntimeUrl}. Run pnpm beaver:build-runtime.'));
          return;
        }

        post(${eventReady});

        var compiled;
        try {
          compiled = window.Babel.transform(${sourceJson}, {
            filename: 'artifact.tsx',
            presets: ['typescript', 'react'],
          }).code;
        } catch (err) {
          reportError('babel-transform', err);
          return;
        }

        try {
          // User TSX runs in this sandboxed iframe (no allow-same-origin).
          (0, eval)(compiled);
          var Component = window.__OpenDesignComponent ||
            (typeof Prototype !== 'undefined' ? Prototype : null) ||
            (typeof App !== 'undefined' ? App : null);
          if (!Component) {
            throw new Error('No React component export found. The artifact must default-export a component named Prototype.');
          }
          window.ReactDOM.createRoot(ROOT).render(window.React.createElement(Component));
          // We can't tell synchronously whether render itself threw — React
          // logs that via its dev runtime which we can't easily intercept
          // without plumbing in an error boundary. As a pragmatic signal,
          // post "rendered" after a microtask: if render threw synchronously,
          // the catch block above fires first.
          Promise.resolve().then(function(){ post(${eventRendered}); });
        } catch (err) {
          reportError('mount', err);
        }

        // Catch any uncaught errors that escape our try/catch (async, event
        // handler from user code, etc).
        window.addEventListener('error', function(ev){
          reportError('uncaught', ev.error || new Error(ev.message || 'unknown'));
        });
        window.addEventListener('unhandledrejection', function(ev){
          reportError('unhandled-rejection', ev.reason || new Error('unhandled promise rejection'));
        });
      })();
    </script>
  </body>
</html>`;
}

/**
 * Rewrite `import { Foo } from '@beaver-ui/<pkg>'` and inner-DS imports
 * into `const { Foo } = window.Beaver;` (or `window.Beaver.tokens` for
 * `/design-tokens` paths).
 *
 * v2 policy: this is a runtime *resolver*, not a *security gate*. Imports
 * from non-allowlisted sources are passed through unchanged — they then
 * fail at runtime as "module not found" or "X is not defined", which
 * routes through the auto-correction loop. Validating in code only
 * duplicates what runtime does and produces false positives.
 *
 * Imports from `react` / `react-dom` / `react/jsx-runtime` are also passed
 * through untouched; the downstream `prepareReactComponentSource` rewrites
 * them to point at `window.React`.
 */
export function rewriteBeaverImports(source: string): string {
  const lines = source.split(/\r?\n/);
  const out: string[] = [];
  for (const rawLine of lines) {
    const line = rawLine;
    const importMatch = line.match(
      /^\s*import\s+(?:type\s+)?(.+?)\s+from\s+['"]([^'"]+)['"];?\s*$/,
    );
    if (!importMatch) {
      out.push(line);
      continue;
    }
    const [, specifier, sourcePath] = importMatch as [string, string, string];

    // React imports — passthrough, prepareReactComponentSource handles them.
    if (
      sourcePath === 'react' ||
      sourcePath === 'react-dom' ||
      sourcePath === 'react/jsx-runtime'
    ) {
      out.push(line);
      continue;
    }

    // Beaver / inner-DS imports → destructure from window.Beaver(.tokens).
    const isAllowed = ALLOWED_IMPORT_PREFIXES.some((prefix) =>
      sourcePath.startsWith(prefix),
    );
    if (!isAllowed) {
      // Not an import we know how to resolve. Pass it through; if the
      // module truly is missing at runtime, eval will throw and the error
      // routes to the parent. This is intentional — we don't reject in
      // code, we let the runtime decide.
      out.push(line);
      continue;
    }

    const isTokens =
      sourcePath.endsWith(TOKENS_PACKAGE_SUFFIX) ||
      sourcePath.includes(`${TOKENS_PACKAGE_SUFFIX}/`);
    const lookupRoot = isTokens ? 'window.Beaver.tokens' : 'window.Beaver';

    const destructurings = parseImportSpecifier(specifier);
    if (destructurings.length === 0) {
      // Side-effect-only import — drop, since the bundle already contains
      // any side effects from initial UMD load.
      continue;
    }
    out.push(...destructurings.map((d) => renderDestructuring(d, lookupRoot)));
  }
  return out.join('\n');
}

type Destructuring =
  | { kind: 'named'; pairs: Array<{ imported: string; local: string }> }
  | { kind: 'default'; local: string }
  | { kind: 'namespace'; local: string };

function parseImportSpecifier(specifier: string): Destructuring[] {
  const trimmed = specifier.trim();
  const namespaceMatch = trimmed.match(/^\*\s+as\s+([A-Za-z_$][\w$]*)$/);
  if (namespaceMatch) {
    return [{ kind: 'namespace', local: namespaceMatch[1]! }];
  }

  const out: Destructuring[] = [];
  const namedMatch = trimmed.match(/\{([\s\S]*)\}/);
  const namedPart = namedMatch?.[1]?.trim() ?? '';
  const defaultPart = trimmed
    .replace(/\{[\s\S]*\}/, '')
    .replace(/,\s*$/, '')
    .trim();

  if (defaultPart) {
    out.push({ kind: 'default', local: defaultPart });
  }
  if (namedPart) {
    const pairs = namedPart
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean)
      .filter((part) => !part.startsWith('type '))
      .map((part) => {
        const asMatch = part.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/);
        if (asMatch) return { imported: asMatch[1]!, local: asMatch[2]! };
        return { imported: part, local: part };
      });
    if (pairs.length > 0) out.push({ kind: 'named', pairs });
  }
  return out;
}

function renderDestructuring(d: Destructuring, lookupRoot: string): string {
  if (d.kind === 'namespace') {
    // `import * as colors from '@inner-ds/design-tokens/colors'` → `const colors = window.Beaver.tokens.colors;`
    // We can't preserve the sub-path here without parsing it, so the namespace import
    // simply binds to the whole tokens / Beaver root. Authors who need a slice should
    // use a named import instead.
    return `const ${d.local} = ${lookupRoot};`;
  }
  if (d.kind === 'default') {
    // Beaver packages don't ship default exports (they're always named).
    // We treat a default import as if it were the package's own namespace —
    // i.e. the same handling as `* as`.
    return `const ${d.local} = ${lookupRoot};`;
  }
  const pairs = d.pairs
    .map(({ imported, local }) =>
      imported === local ? imported : `${imported}: ${local}`,
    )
    .join(', ');
  return `const { ${pairs} } = ${lookupRoot};`;
}

// errorPageHtml removed in v2 — the iframe no longer renders user-facing
// error UI. All error states are routed through postMessage events to the
// parent, which decides UX (typically: hide iframe, show "model is fixing"
// indicator, send correction prompt, swap in new srcdoc on success).

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttr(value: string): string {
  return value.replace(/"/g, '&quot;');
}
