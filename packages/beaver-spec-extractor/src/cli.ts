#!/usr/bin/env node
import { resolve } from 'node:path';
import { runSync } from './sync.js';

type Args = {
  beaver: string | undefined;
  inner: string | undefined;
  out: string;
};

function parseArgs(argv: string[]): Args {
  const args: Args = { beaver: undefined, inner: undefined, out: 'skills/beaver-prototype' };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--beaver' && next) {
      args.beaver = next;
      i += 1;
    } else if (arg === '--inner' && next) {
      args.inner = next;
      i += 1;
    } else if (arg === '--out' && next) {
      args.out = next;
      i += 1;
    } else if (arg === '-h' || arg === '--help') {
      printHelp();
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${arg}`);
      printHelp();
      process.exit(1);
    }
  }
  return args;
}

function printHelp(): void {
  console.log(`Usage: beaver-sync --beaver <path> [--inner <path>] [--out <path>]

  --beaver  Path to a local checkout of the Beaver UI source repository.
            Required. The CLI scans <path>/packages/* for stories and .d.ts.
  --inner   Path to the inner DS source repository (the one Beaver consumes
            for primitives + design-tokens). Optional — if omitted, the CLI
            looks for it inside <beaver>/node_modules or as a sibling
            directory.
  --out     Where to write the manifest + reference docs. Defaults to
            skills/beaver-prototype (relative to repo root).
`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  if (!args.beaver) {
    console.error('error: --beaver <path> is required.\n');
    printHelp();
    process.exit(1);
  }
  await runSync({
    beaverRoot: resolve(args.beaver),
    innerRoot: args.inner ? resolve(args.inner) : undefined,
    outDir: resolve(args.out),
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
