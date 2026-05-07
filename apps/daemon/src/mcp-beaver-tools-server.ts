// @ts-nocheck
//
// MCP stdio server exposing the six Beaver design-system tools to a
// coding agent (qwen-code in our deployment, but any MCP-capable client
// works). Each tool reads from `skills/beaver-prototype/` (the spec
// extractor's output) and returns small structured JSON payloads.
//
// Spawn this as a child process; the agent connects via stdin/stdout.
// Example invocation: `od beaver-mcp --skill-dir <abs-path-to-skill-dir>`.
//
// This server is intentionally separate from the project-aware MCP
// server in `mcp.ts`. That one proxies HTTP API calls to a running
// daemon; this one is fully filesystem-based and works without a daemon
// at all (you just need `pnpm beaver:sync` to have run once). The
// separation keeps the server boundary clean — no shared state, no
// cross-server dependencies, and either can be enabled independently.
//
// `@ts-nocheck` mirrors mcp.ts: the SDK expects Zod schemas but we pass
// plain JSON Schema objects; the runtime contract is identical.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import {
  beaverSearchComponents,
  beaverGetComponentSpec,
  beaverListTokenGroups,
  beaverGetTokens,
  beaverSearchDocs,
  beaverDryRun,
  BEAVER_TOOL_DESCRIPTORS,
  type BeaverToolsContext,
  type BeaverDryRunFn,
} from './beaver-tools.js';

const SERVER_NAME = 'beaver-tools';
const SERVER_VERSION = '0.1.0';

const SERVER_INSTRUCTIONS = `
This MCP server exposes the Beaver UI design system to the agent.

The agent should call these tools BEFORE writing any TSX:
  - beaver_search_components — find components matching the requested role.
  - beaver_get_component_spec — read full props for every chosen component.
  - beaver_list_token_groups + beaver_get_tokens — fetch token values for
    any visual override.
  - beaver_search_docs — when component spec alone is not enough.

And BEFORE emitting <artifact>, the agent calls:
  - beaver_dry_run — to verify the TSX renders without runtime errors.

The user does not see broken iframes; if dry_run fails, the agent fixes
the TSX and re-runs dry_run until it passes. Only successful renders
reach the preview pane.

Beaver components are the primary surface. Inner-DS primitives (returned
with tier="fallback") are used only when no Beaver component fits.
Tokens live exclusively in inner-DS.
`.trim();

function descriptorToToolDef(descriptor: (typeof BEAVER_TOOL_DESCRIPTORS)[number]) {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [paramName, param] of Object.entries(descriptor.parameters)) {
    properties[paramName] = {
      type: param.type,
      description: param.description,
    };
    if (param.required) required.push(paramName);
  }
  return {
    name: descriptor.name,
    description: descriptor.description,
    inputSchema: {
      type: 'object',
      properties,
      ...(required.length > 0 ? { required } : {}),
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: descriptor.name !== 'beaver_dry_run',
      idempotentHint: true,
      openWorldHint: false,
      title: descriptor.name,
    },
  };
}

function ok(payload: unknown) {
  return {
    content: [
      {
        type: 'text',
        text: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2),
      },
    ],
  };
}

function fail(message: string) {
  return {
    isError: true,
    content: [{ type: 'text', text: message }],
  };
}

interface ServerStartOptions {
  skillDir: string;
  /**
   * Optional dry-run runner. If absent, beaver_dry_run returns
   * `{ ok: false, reason: 'unavailable' }`. The local agent should
   * provide one wired to a JSDOM-or-Playwright shim that loads the same
   * UMD as the iframe (`apps/beaver-runtime/dist/beaver.umd.js`). See
   * LOCAL-AGENT-HANDOFF.md for what a real dryRun must do.
   */
  dryRun?: BeaverDryRunFn;
}

export async function startBeaverToolsMcpServer(
  options: ServerStartOptions,
): Promise<void> {
  const ctx: BeaverToolsContext = {
    skillDir: options.skillDir,
    ...(options.dryRun ? { dryRun: options.dryRun } : {}),
  };

  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: { tools: {} },
      instructions: SERVER_INSTRUCTIONS,
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: BEAVER_TOOL_DESCRIPTORS.map(descriptorToToolDef) };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params?.name;
    const args = req.params?.arguments ?? {};
    try {
      switch (name) {
        case 'beaver_search_components':
          return ok(
            await beaverSearchComponents(ctx, {
              query: typeof args.query === 'string' ? args.query : '',
              limit:
                typeof args.limit === 'number' && Number.isFinite(args.limit)
                  ? args.limit
                  : undefined,
            }),
          );
        case 'beaver_get_component_spec':
          return ok(
            await beaverGetComponentSpec(ctx, {
              name: typeof args.name === 'string' ? args.name : '',
            }),
          );
        case 'beaver_list_token_groups':
          return ok(await beaverListTokenGroups(ctx));
        case 'beaver_get_tokens':
          return ok(
            await beaverGetTokens(ctx, {
              group: typeof args.group === 'string' ? args.group : '',
            }),
          );
        case 'beaver_search_docs':
          return ok(
            await beaverSearchDocs(ctx, {
              query: typeof args.query === 'string' ? args.query : '',
              limit:
                typeof args.limit === 'number' && Number.isFinite(args.limit)
                  ? args.limit
                  : undefined,
            }),
          );
        case 'beaver_dry_run':
          return ok(
            await beaverDryRun(ctx, {
              source: typeof args.source === 'string' ? args.source : '',
            }),
          );
        default:
          return fail(`Unknown tool: ${name}`);
      }
    } catch (err) {
      return fail(
        `Tool ${name} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
