import { HttpClient } from "./client.js";
import { McpResource } from "./mcp.js";
import { CatalogResource } from "./catalog.js";
import { startStdioServer } from "./mcp-stdio.js";

declare const __SDK_VERSION__: string;

const VERSION = __SDK_VERSION__;

function usage(): void {
  console.log(`
@cognitum/sdk CLI v${VERSION}

Usage: cognitum <command> [options]

Commands:
  health          Check API health
  catalog         Browse product catalog
  tools           List available MCP tools
  call <tool>     Call an MCP tool (pass JSON args as second argument)
  keys            Manage API keys (opens dashboard)
  mcp             Start stdio MCP server for Claude Code

Options:
  --key, -k       API key (or set COGNITUM_API_KEY env var)
  --base-url      API base URL (default: https://api.cognitum.one)
  --json          Output raw JSON
  --help, -h      Show this help

Examples:
  cognitum health --key cog_abc123
  cognitum catalog
  cognitum call health_check
  cognitum call catalog_browse '{"category":"devices"}'
  cognitum mcp --key cog_abc123

Claude Code integration:
  claude mcp add cognitum -- npx @cognitum/sdk mcp --key cog_abc123
`.trim());
}

function parseArgs(argv: string[]): { command: string; args: string[]; flags: Record<string, string | boolean> } {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === "--key" || arg === "-k") {
      flags.key = argv[++i] || "";
    } else if (arg === "--base-url") {
      flags.baseUrl = argv[++i] || "";
    } else if (arg === "--json") {
      flags.json = true;
    } else if (arg === "--version" || arg === "-v") {
      flags.version = true;
    } else if (arg === "--help" || arg === "-h") {
      flags.help = true;
    } else if (!arg.startsWith("-")) {
      positional.push(arg);
    }
    i++;
  }

  return {
    command: positional[0] || "",
    args: positional.slice(1),
    flags,
  };
}

async function main(): Promise<void> {
  const { command, args, flags } = parseArgs(process.argv.slice(2));

  if (flags.version) {
    console.log(VERSION);
    return;
  }

  if (flags.help || !command) {
    usage();
    process.exit(command ? 0 : 1);
  }

  const apiKey = (flags.key as string) || process.env.COGNITUM_API_KEY || "";
  const baseUrl = (flags.baseUrl as string) || undefined;

  if (!apiKey && command !== "help" && command !== "keys") {
    console.error("Error: API key required. Use --key or set COGNITUM_API_KEY env var.");
    process.exit(1);
  }

  // MCP mode - hand off to stdio server
  if (command === "mcp") {
    await startStdioServer(apiKey, baseUrl);
    return;
  }

  // Keys command doesn't need an API key
  if (command === "keys") {
    console.log("API key management is available at:");
    console.log("  https://manage.cognitum.one/api-keys");
    console.log("");
    console.log("Or view your key on the order page:");
    console.log("  https://cognitum.one/order (API / SDK tab)");
    return;
  }

  const client = new HttpClient({ apiKey, baseUrl });
  const mcp = new McpResource(client);
  const catalog = new CatalogResource(client);
  const json = !!flags.json;

  try {
    switch (command) {
      case "health": {
        const health = await client.request<any>("GET", "/apiHealth");
        if (json) {
          console.log(JSON.stringify(health, null, 2));
        } else {
          console.log(`Status:    ${health.status}`);
          console.log(`Version:   ${health.version}`);
          console.log(`Timestamp: ${health.timestamp}`);
        }
        break;
      }

      case "catalog": {
        const result = await catalog.browse();
        if (json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          const products = result.products || [];
          if (products.length === 0) {
            console.log("No products found.");
          } else {
            for (const p of products) {
              const price = p.price ? `$${(p.price / 100).toFixed(0)}` : "N/A";
              const status = p.available ? "available" : "coming soon";
              console.log(`${p.name}  ${price}  ${status}`);
            }
          }
        }
        break;
      }

      case "tools": {
        const result = await mcp.listTools();
        const tools = (result as any).tools || result || [];
        if (json) {
          console.log(JSON.stringify(tools, null, 2));
        } else {
          for (const t of tools) {
            const name = (t.name || "").padEnd(25);
            console.log(`${name} ${t.description || ""}`);
          }
        }
        break;
      }

      case "call": {
        const toolName = args[0];
        if (!toolName) {
          console.error("Usage: cognitum call <tool-name> [json-args]");
          process.exit(1);
        }
        let toolArgs: Record<string, unknown> = {};
        if (args[1]) {
          try {
            toolArgs = JSON.parse(args[1]);
          } catch {
            console.error("Error: Invalid JSON arguments");
            process.exit(1);
          }
        }
        const result = await mcp.callTool(toolName, toolArgs);
        if (json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          // Extract text from MCP content
          const content = (result as any)?.result?.content ?? result?.content ?? [];
          for (const c of Array.isArray(content) ? content : []) {
            if (c.type === "text" && c.text) {
              try {
                const parsed = JSON.parse(c.text);
                console.log(JSON.stringify(parsed, null, 2));
              } catch {
                console.log(c.text);
              }
            }
          }
        }
        break;
      }

      default:
        console.error(`Unknown command: ${command}`);
        usage();
        process.exit(1);
    }
  } catch (e: any) {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(`Fatal: ${e.message}`);
  process.exit(1);
});
