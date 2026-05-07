#!/usr/bin/env node
/**
 * `pnpm beaver:sync` entry point.
 *
 * Orchestrates four phases (bundle introspection → props → tokens →
 * docs) and writes the result to `skills/beaver-prototype/`. See
 * src/sync.ts for the contract.
 */
import { resolve, join } from 'node:path';
import { runSync } from './sync.js';

interface CliArgs {
  beaver?: string;
  inner?: string;
  bundle?: string;
  nodeModules?: string;
  out?: string;
  primaryScope?: string;
  innerScope?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {};
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    switch (arg) {
      case '--beaver':
        args.beaver = next;
        i += 1;
        break;
      case '--inner':
        args.inner = next;
        i += 1;
        break;
      case '--bundle':
        args.bundle = next;
        i += 1;
        break;
      case '--node-modules':
        args.nodeModules = next;
        i += 1;
        break;
      case '--out':
        args.out = next;
        i += 1;
        break;
      case '--primary-scope':
        args.primaryScope = next;
        i += 1;
        break;
      case '--inner-scope':
        args.innerScope = next;
        i += 1;
        break;
      case '-h':
      case '--help':
        printHelp();
        process.exit(0);
      default:
        if (arg && arg.startsWith('-')) {
          console.error(`Unknown argument: ${arg}`);
          printHelp();
          process.exit(1);
        }
    }
  }
  return args;
}

function printHelp(): void {
  console.log(
    `Usage: beaver-sync [options]

  --beaver         Path to local Beaver UI source checkout.
                   Optional, but required for the docs corpus to include
                   Beaver-specific JSDoc / MDX.
  --inner          Path to local inner-DS source checkout.
                   Optional, but required for inner-DS docs corpus.
  --bundle         Path to the prebuilt UMD bundle.
                   Default: <repo>/apps/beaver-runtime/dist/beaver.umd.js
  --node-modules   Path to node_modules.
                   Default: <repo>/node_modules
  --out            Output skill directory.
                   Default: <repo>/skills/beaver-prototype
  --primary-scope  Scope considered the "primary" Beaver surface.
                   Default: @beaver-ui
  --inner-scope    Scope considered the "fallback" inner DS.
                   Default: @inner-ds

The bundle and node_modules options resolve relative to the current
working directory if given as relative paths.

Phases:
  1. Introspect the UMD bundle in JSDOM → enumerate window.Beaver,
     classify each export (component / hook / utility / tokens-namespace),
     resolve name → source package via dynamic import of each runtime dep.
  2. Extract props from each package's published .d.ts via the TypeScript
     Compiler API. Captures string-literal unions as enum values, JSDoc
     summaries, and cross-package type references.
  3. Extract token values from the inner-DS design-tokens package, walking
     frozen-object types via the TS Compiler API.
  4. Extract the docs corpus from MDX, top-level JSDoc, and READMEs in the
     source checkouts. Produces one .md per component for the daemon's
     beaver_search_docs tool.

Outputs:
  components.json         — lean manifest (names + tier + kind + paths)
  specs/<Name>.json       — per-component prop specs
  tokens/<group>.json     — per-group token values
  tokens/index.json       — token group index
  docs/<package>/<name>.md — doc corpus
`,
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const repoRoot = process.cwd();

  const bundlePath = args.bundle
    ? resolve(args.bundle)
    : join(repoRoot, 'apps', 'beaver-runtime', 'dist', 'beaver.umd.js');
  const nodeModulesDir = args.nodeModules
    ? resolve(args.nodeModules)
    : join(repoRoot, 'node_modules');
  const skillDir = args.out
    ? resolve(args.out)
    : join(repoRoot, 'skills', 'beaver-prototype');

  const result = await runSync({
    repoRoot,
    skillDir,
    bundlePath,
    nodeModulesDir,
    beaverRoot: args.beaver ? resolve(args.beaver) : undefined,
    innerRoot: args.inner ? resolve(args.inner) : undefined,
    primaryScope: args.primaryScope,
    innerScope: args.innerScope,
  });

  console.log(
    `beaver:sync done — ${result.componentSpecCount} component specs, ${result.tokenGroupCount} token groups, ${result.docFileCount} doc files`,
  );
  if (result.errors.length > 0) {
    console.warn(`(${result.errors.length} non-fatal warnings:)`);
    for (const err of result.errors) {
      console.warn(`  - ${err}`);
    }
  }
}

main().catch((err) => {
  console.error('beaver:sync failed:', err instanceof Error ? err.stack : err);
  process.exit(1);
});
