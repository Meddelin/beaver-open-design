/**
 * Build a sandboxed iframe srcdoc that renders a Beaver UI prototype.
 *
 * This is the Beaver-fork twin of `react-component.ts`. The difference is
 * that user TSX is allowed to import from `@beaver-ui/*`,
 * `@<inner-ds>/components`, and `@<inner-ds>/design-tokens`, plus `react`
 * and `react/jsx-runtime`. Imports from any other source produce an error
 * page (so the LLM gets a clear signal to fix its output).
 *
 * The pipeline:
 *   1. Pre-process the TSX source: convert allowed non-React imports into
 *      `const { … } = window.Beaver(…)` lines, validate any leftover
 *      `import` statements against the allow-list.
 *   2. Reuse the existing `prepareReactComponentSource` to strip the
 *      remaining React imports and rewrite the default export into a
 *      `window.__OpenDesignComponent` assignment.
 *   3. Emit an HTML document that loads (in order): React UMD, ReactDOM
 *      UMD, Babel standalone, then Beaver's UMD + CSS, then a small
 *      bootstrap that Babel-transforms the prepared source and mounts the
 *      component into `#root`.
 */
import { prepareReactComponentSource } from './react-component';

interface BeaverComponentSrcdocOptions {
  title: string;
  /** Path or absolute URL to the Beaver runtime UMD. Defaults to `/vendor/beaver.umd.js`. */
  beaverRuntimeUrl?: string;
  /** Path or absolute URL to the Beaver runtime stylesheet. Defaults to `/vendor/beaver.css`. */
  beaverStylesheetUrl?: string;
}

const REACT_DEV_URL = 'https://unpkg.com/react@18.3.1/umd/react.development.js';
const REACT_DOM_DEV_URL =
  'https://unpkg.com/react-dom@18.3.1/umd/react-dom.development.js';
const BABEL_STANDALONE_URL =
  'https://unpkg.com/@babel/standalone@7.29.0/babel.min.js';

const BEAVER_RUNTIME_URL_DEFAULT = '/vendor/beaver.umd.js';
const BEAVER_STYLESHEET_URL_DEFAULT = '/vendor/beaver.css';

const ALLOWED_IMPORT_PREFIXES = [
  '@beaver-ui/',
  // The inner-DS scope is filled in once `apps/beaver-runtime/src/index.ts`
  // is wired against an actual scope. Callers can pass extra prefixes via
  // `BEAVER_EXTRA_ALLOWED_PREFIXES` env at build time if they need to lock
  // a different scope name.
  '@inner-ds/',
] as const;

const TOKENS_PACKAGE_SUFFIX = '/design-tokens';

export class BeaverImportError extends Error {
  constructor(
    public readonly source: string,
    public readonly reason: string,
  ) {
    super(`Disallowed import in artifact: ${source} (${reason})`);
  }
}

export function buildBeaverComponentSrcdoc(
  source: string,
  options: BeaverComponentSrcdocOptions,
): string {
  let prepared: string;
  let importError: BeaverImportError | null = null;
  try {
    const rewritten = rewriteBeaverImports(source);
    prepared = prepareReactComponentSource(rewritten);
  } catch (err) {
    importError = err instanceof BeaverImportError ? err : null;
    prepared = '';
  }

  const safeTitle = escapeHtml(options.title || 'Beaver prototype');
  const beaverRuntimeUrl = options.beaverRuntimeUrl ?? BEAVER_RUNTIME_URL_DEFAULT;
  const beaverStylesheetUrl =
    options.beaverStylesheetUrl ?? BEAVER_STYLESHEET_URL_DEFAULT;

  if (importError) {
    return errorPageHtml(safeTitle, importError.message);
  }

  const sourceJson = JSON.stringify(prepared);

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
      .od-react-error {
        margin: 16px;
        padding: 14px 16px;
        border: 1px solid #fecaca;
        border-radius: 8px;
        background: #fff1f2;
        color: #991b1b;
        font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
        white-space: pre-wrap;
      }
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
        var root = document.getElementById('root');
        function showError(err) {
          root.innerHTML = '';
          var el = document.createElement('pre');
          el.className = 'od-react-error';
          el.textContent = err && (err.stack || err.message) ? (err.stack || err.message) : String(err);
          root.appendChild(el);
        }
        if (!window.React || !window.ReactDOM || !window.Babel) {
          showError(new Error('React preview runtime failed to load.'));
          return;
        }
        if (!window.Beaver) {
          showError(new Error('Beaver runtime not loaded. Did you run "pnpm beaver:build-runtime"? Expected a UMD at ${beaverRuntimeUrl}.'));
          return;
        }
        var compiled;
        try {
          compiled = window.Babel.transform(${sourceJson}, {
            filename: 'artifact.tsx',
            presets: ['typescript', 'react'],
          }).code;
        } catch (err) {
          showError(err);
          return;
        }
        try {
          // User-authored JSX runs only inside this sandboxed iframe. The parent omits
          // allow-same-origin, so runtime effects are confined to the preview document.
          (0, eval)(compiled);
          var Component = window.__OpenDesignComponent ||
            (typeof Prototype !== 'undefined' ? Prototype : null) ||
            (typeof App !== 'undefined' ? App : null);
          if (!Component) {
            throw new Error('No React component export found. Export a default component named Prototype.');
          }
          window.ReactDOM.createRoot(root).render(window.React.createElement(Component));
        } catch (err) {
          showError(err);
        }
      })();
    </script>
  </body>
</html>`;
}

/**
 * Rewrite `import { Foo } from '@beaver-ui/<pkg>'` lines into
 * `const { Foo } = window.Beaver;`. Tokens imports go to
 * `window.Beaver.tokens`. Throws BeaverImportError on disallowed sources.
 *
 * Imports from `react` / `react/jsx-runtime` are left untouched here — the
 * downstream `prepareReactComponentSource` rewrites them to point at
 * `window.React`.
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

    if (sourcePath === 'react' || sourcePath === 'react-dom' || sourcePath === 'react/jsx-runtime') {
      out.push(line);
      continue;
    }

    const allowed = ALLOWED_IMPORT_PREFIXES.some((prefix) => sourcePath.startsWith(prefix));
    if (!allowed) {
      throw new BeaverImportError(
        sourcePath,
        `imports must be from react, @beaver-ui/*, or @<inner-ds>/* (including /design-tokens). Update the artifact and ask Beaver UI for the right component name.`,
      );
    }

    // The bundler exposes both components and tokens on `window.Beaver`,
    // with tokens nested under `.tokens`. Choose which root to destructure
    // from based on whether the import path ends with /design-tokens.
    const isTokens =
      sourcePath.endsWith(TOKENS_PACKAGE_SUFFIX) ||
      sourcePath.includes(`${TOKENS_PACKAGE_SUFFIX}/`);
    const lookupRoot = isTokens ? 'window.Beaver.tokens' : 'window.Beaver';

    const destructurings = parseImportSpecifier(specifier);
    if (destructurings.length === 0) {
      // `import 'foo';` side-effect-only — pointless for our domain, drop it.
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

function errorPageHtml(title: string, message: string): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>${title}</title>
    <style>
      body { font: 13px/1.5 ui-monospace, monospace; padding: 24px; background: #fff1f2; color: #991b1b; }
      pre { white-space: pre-wrap; }
    </style>
  </head>
  <body>
    <h2>Beaver preview rejected the artifact</h2>
    <pre>${escapeHtml(message)}</pre>
  </body>
</html>`;
}

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
