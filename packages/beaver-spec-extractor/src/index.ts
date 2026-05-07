/**
 * Public surface of @beaver-open-design/spec-extractor.
 *
 * Re-exports types so consumers (e.g. apps/daemon/src/beaver-tools.ts)
 * can pull the same shapes the extractor produces. The CLI entry is
 * a separate file (cli.ts) and not included here.
 */
export type {
  Tier,
  ComponentKind,
  ManifestEntry,
  Manifest,
  PropSpec,
  TypeReference,
  ComponentSpec,
  ExampleSnippet,
  TokenEntry,
  TokenObject,
  TokenGroup,
  BundleIntrospectionResult,
  BundleExport,
  ExtractorInputs,
} from './types.js';
