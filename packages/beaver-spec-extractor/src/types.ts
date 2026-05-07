/**
 * Shared types for the beaver spec extractor v2.
 *
 * The extractor produces three artifacts that get consumed by the daemon
 * at runtime via the beaver-tools layer:
 *
 *   1. components.json — lean manifest. Names by package, with tier and
 *      kind. NOT the full prop spec; it is the index that beaver-tools
 *      uses for search and ranking.
 *   2. specs/<Component>.json — per-component full spec. Props, examples,
 *      referencedTypes (cross-package). Fetched lazily by
 *      beaver_get_component_spec.
 *   3. tokens/<group>.json — per-group token values. Fetched lazily by
 *      beaver_get_tokens.
 *   4. docs/<package>/<name>.md — per-component description corpus.
 *      Fetched lazily by beaver_get_component_spec (linked) and
 *      beaver_search_docs (full-text searched).
 */

export type Tier = 'primary' | 'fallback';

export type ComponentKind =
  | 'layout'
  | 'input'
  | 'feedback'
  | 'overlay'
  | 'data-display'
  | 'navigation'
  | 'typography'
  | 'media'
  | 'utility'
  | 'unknown';

/**
 * One row of components.json. Lean by design — props and examples live in
 * separate per-component files to keep the manifest small and cheap to
 * inline into prompts (only the names are inlined; full spec fetched on
 * demand).
 */
export interface ManifestEntry {
  name: string;
  package: string;
  tier: Tier;
  kind: ComponentKind;
  /** Path under skills/beaver-prototype/ to the per-component spec. */
  specPath: string;
  /** Optional path under skills/beaver-prototype/ to the doc file. */
  docPath?: string;
  /** Optional one-liner extracted from JSDoc / Storybook description. */
  oneLineDescription?: string;
}

/**
 * Top-level shape of components.json.
 */
export interface Manifest {
  generatedAt: string;
  generatedBy: string;
  beaverVersion: string | null;
  innerDsVersion: string | null;
  components: ManifestEntry[];
  /** Token group names (just labels; values are in tokens/<group>.json). */
  tokenGroups: string[];
}

/**
 * One prop in a component spec.
 */
export interface PropSpec {
  name: string;
  /** Best-effort textual representation of the type. */
  type: string;
  required: boolean;
  /** Default expression as a string, if extractable. */
  default?: string;
  description?: string;
  /** If the type is a string-literal union, the values. */
  enumValues?: string[];
  /**
   * If the prop's type references a named type from another package
   * (typical case: Beaver Button uses an inner-DS Size enum), the chain of
   * referenced types. The model can fetch each via beaver_get_component_spec
   * (which doubles as a generic type lookup when the name is a type, not
   * a component).
   */
  referencedTypes?: TypeReference[];
}

export interface TypeReference {
  name: string;
  /** Package the named type comes from. */
  package: string;
  /** Whether we resolved the body of this type (we may have just the link). */
  resolved: boolean;
}

/**
 * Full per-component spec. Stored at
 * skills/beaver-prototype/specs/<Component>.json.
 */
export interface ComponentSpec {
  name: string;
  package: string;
  tier: Tier;
  importStatement: string;
  description?: string;
  props: PropSpec[];
  examples: ExampleSnippet[];
  /**
   * Sub-component sibling names from the same package. Surfaced so the
   * model knows that, e.g., `Header` ships `HeaderTitle` / `HeaderSegments`
   * in the same import line.
   */
  siblingComponents: string[];
}

export interface ExampleSnippet {
  /** Where the example came from (story file path, MDX file, etc.). */
  source: string;
  /** TSX / JS source of the example. */
  code: string;
  /** Optional story / example title. */
  title?: string;
}

/**
 * One row of a token group. The flat `path` is the JS access path
 * (`color.brand.primary.default`); `value` is whatever the inner-DS
 * exports — a string, a number, or a nested object that wasn't fully
 * resolved.
 */
export interface TokenEntry {
  path: string;
  value: string | number | boolean | null | TokenObject;
}

export interface TokenObject {
  [key: string]: string | number | boolean | null | TokenObject;
}

export interface TokenGroup {
  group: string;
  /** The import path the user TSX should use to access this group. */
  importPath: string;
  description?: string;
  entries: TokenEntry[];
}

/**
 * Result of `pnpm beaver:introspect-bundle`.
 */
export interface BundleIntrospectionResult {
  /** Names exported on `window.Beaver`, partitioned by typeof. */
  exports: BundleExport[];
  /** Token group names found on `window.Beaver.tokens`. */
  tokenGroups: string[];
  /**
   * Map from exported name → source package (best-effort, matched by
   * dynamically importing each runtime dep and checking `Object.keys`).
   * Names not resolvable to a package are absent from the map.
   */
  packageOf: Record<string, string>;
}

export interface BundleExport {
  name: string;
  /** typeof window.Beaver[name] */
  typeOf: 'function' | 'object' | 'string' | 'number' | 'boolean' | 'undefined' | 'symbol' | 'bigint';
  /** Heuristic guess at what this export is. */
  classification: 'component' | 'hook' | 'utility' | 'tokens-namespace' | 'unknown';
}

/**
 * Inputs to all extractors. Most are paths into local checkouts of the
 * Beaver / inner-DS source repositories.
 */
export interface ExtractorInputs {
  /** Path to local checkout of the Beaver source repo. Required for docs. */
  beaverRoot?: string;
  /** Path to local checkout of the inner-DS source repo (for docs and tokens). */
  innerRoot?: string;
  /** Repo root of the fork. Defaults to process.cwd(). */
  repoRoot: string;
  /** Output skill directory. Defaults to `<repoRoot>/skills/beaver-prototype`. */
  skillDir: string;
  /** Path to the built UMD bundle. */
  bundlePath: string;
  /** node_modules dir to resolve runtime deps from. */
  nodeModulesDir: string;
}
