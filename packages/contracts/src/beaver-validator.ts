/**
 * Beaver artifact validator (v2).
 *
 * The fork's validation philosophy: code checks ONLY parseability. Anything
 * past that — correct imports, real component names, valid props, no
 * customization beyond props, no third-party libs — is the model's
 * responsibility, enforced by the system prompt and (when violations slip
 * through) by the runtime auto-correction loop. Trying to predict what the
 * model "should" do creates false positives and blocks valid output.
 *
 * Therefore this module exposes a single function `validateBeaverArtifact`
 * with one level of validation: L1 (Babel parse). Anything that parses
 * gets through, regardless of what it imports or which JSX tags it uses.
 *
 * The level naming (L1) is preserved from the older 4-level validator so
 * that callers thinking in terms of validation tiers can map their code
 * over without an enum rename. L2/L3/L4 are intentionally absent.
 *
 * Implementation note: this module does NOT take a hard dependency on
 * @babel/standalone or @babel/parser (they're heavy and may not be
 * available everywhere). Instead, callers inject a parser function. The
 * web client passes `window.Babel.transform`; daemon passes the same via
 * a Node-side @babel/parser. This keeps `packages/contracts` pure and
 * deployable in any environment.
 */

/**
 * Identifies the validation step that produced an issue. Currently only
 * 'parse' (L1). Reserved-but-unused values exist as type slots so future
 * code can extend cleanly.
 */
export type BeaverValidationLevel = 'parse';

export interface BeaverValidationIssue {
  level: BeaverValidationLevel;
  /** Human-readable error, suitable for an LLM correction prompt. */
  message: string;
  /** Best-effort line number (1-based) extracted from the error, when available. */
  line?: number;
  /** Best-effort column number (1-based) extracted from the error, when available. */
  column?: number;
  /** Original error name / kind, if the parser provided one (e.g. "SyntaxError"). */
  errorKind?: string;
}

export interface BeaverValidationResult {
  ok: boolean;
  issues: BeaverValidationIssue[];
}

/**
 * Minimal contract a parser must satisfy. Both `@babel/parser` and
 * `window.Babel.transform` can be wrapped to fit. The function should
 * throw on parse error — that error is caught here and converted to a
 * BeaverValidationIssue.
 */
export type BeaverParseFn = (source: string) => unknown;

export interface ValidateBeaverArtifactOptions {
  /** The TSX source as the LLM emitted it. */
  source: string;
  /** Parser shim. Must throw on syntactic error. */
  parse: BeaverParseFn;
}

export function validateBeaverArtifact(
  options: ValidateBeaverArtifactOptions,
): BeaverValidationResult {
  const issues: BeaverValidationIssue[] = [];

  try {
    options.parse(options.source);
  } catch (err) {
    issues.push(toParseIssue(err));
  }

  return {
    ok: issues.length === 0,
    issues,
  };
}

/**
 * Build a parse function from `@babel/standalone` (browser) or
 * `@babel/parser` (Node). The function throws on syntax error with a
 * BabelError-shaped object that has `loc` and `message`.
 *
 * In daemon (Node), prefer `@babel/parser` directly:
 *   const parse = (src) => babelParser.parse(src, { sourceType: 'module', plugins: ['typescript', 'jsx'] });
 *
 * In browser (web), use `window.Babel.transform`:
 *   const parse = (src) => window.Babel.transform(src, { presets: ['typescript', 'react'] });
 *
 * Both signatures throw on syntax error; this validator's job is just to
 * convert that exception into a structured issue for the auto-correction
 * loop.
 */

function toParseIssue(err: unknown): BeaverValidationIssue {
  const message = err instanceof Error ? err.message : String(err);
  const errorKind = err instanceof Error ? err.name : undefined;

  // Babel errors expose .loc.line / .loc.column or, in transform mode,
  // pack the location into the message as "(line:col)".
  let line: number | undefined;
  let column: number | undefined;
  if (err && typeof err === 'object') {
    const loc = (err as { loc?: { line?: number; column?: number } }).loc;
    if (loc) {
      if (typeof loc.line === 'number') line = loc.line;
      if (typeof loc.column === 'number') column = loc.column;
    }
  }
  if (line == null || column == null) {
    const m = /\((\d+):(\d+)\)/.exec(message);
    if (m) {
      line = line ?? Number(m[1]);
      column = column ?? Number(m[2]);
    }
  }

  return {
    level: 'parse',
    message,
    ...(typeof line === 'number' ? { line } : {}),
    ...(typeof column === 'number' ? { column } : {}),
    ...(errorKind ? { errorKind } : {}),
  };
}

/**
 * Render an issue list into a correction prompt suitable for feeding back
 * into the agent loop. The output is plain text, deterministic, and
 * starts with the `[automated correction request]` marker that
 * `BEAVER_DISCOVERY_AND_FLOW`'s self-correction protocol references.
 */
export function renderBeaverCorrectionPrompt(
  issues: BeaverValidationIssue[],
): string {
  if (issues.length === 0) return '';

  const lines: string[] = [];
  lines.push('[automated correction request]');
  lines.push('');
  lines.push('Your previous artifact failed pre-mount validation. Fix and re-emit.');
  lines.push('');
  for (const issue of issues) {
    const loc =
      issue.line != null && issue.column != null
        ? ` at line ${issue.line}:${issue.column}`
        : issue.line != null
          ? ` at line ${issue.line}`
          : '';
    lines.push(`- [${issue.level}] ${issue.message}${loc}`);
  }
  lines.push('');
  lines.push(
    'Run `beaver_dry_run(source)` before emitting the corrected artifact. Do not narrate the fix; emit a clean `<artifact>` block.',
  );
  return lines.join('\n');
}
