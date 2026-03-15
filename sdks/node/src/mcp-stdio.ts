import { createInterface } from "node:readline";
import { HttpClient } from "./client.js";

interface JsonRpcRequest {
  jsonrpc: string;
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: string;
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

const SERVER_INFO = {
  name: "cognitum",
  version: "1.1.0",
};

const CAPABILITIES = {
  tools: { listChanged: false },
};

export async function startStdioServer(apiKey: string, baseUrl?: string): Promise<void> {
  const client = new HttpClient({
    apiKey,
    baseUrl: baseUrl || "https://api.cognitum.one",
  });

  let toolsCache: any[] | null = null;

  function send(response: JsonRpcResponse): void {
    process.stdout.write(JSON.stringify(response) + "\n");
  }

  function log(...args: unknown[]): void {
    process.stderr.write(`[cognitum-mcp] ${args.join(" ")}\n`);
  }

  async function getTools(): Promise<any[]> {
    if (toolsCache) return toolsCache;
    try {
      const result = await client.request<any>("GET", "/apiMcpTools");
      toolsCache = result.tools || result || [];
      return toolsCache!;
    } catch (e: any) {
      log("Failed to fetch tools:", e.message);
      return [];
    }
  }

  async function handleRequest(req: JsonRpcRequest): Promise<void> {
    const id = req.id ?? null;

    // Notifications (no id) don't get responses
    if (id === null && req.method.startsWith("notifications/")) {
      return;
    }

    try {
      switch (req.method) {
        case "initialize": {
          send({
            jsonrpc: "2.0",
            id,
            result: {
              protocolVersion: "2024-11-05",
              serverInfo: SERVER_INFO,
              capabilities: CAPABILITIES,
            },
          });
          break;
        }

        case "initialized": {
          // Acknowledgment - no response needed for notification
          if (id !== null) {
            send({ jsonrpc: "2.0", id, result: {} });
          }
          break;
        }

        case "tools/list": {
          const tools = await getTools();
          send({ jsonrpc: "2.0", id, result: { tools } });
          break;
        }

        case "tools/call": {
          const toolName = (req.params as any)?.name;
          const toolArgs = (req.params as any)?.arguments || {};

          if (!toolName) {
            send({
              jsonrpc: "2.0",
              id,
              error: { code: -32602, message: "Missing tool name" },
            });
            break;
          }

          // Proxy to the live MCP SSE endpoint
          const result = await client.request<any>("POST", "/mcpSse", {
            jsonrpc: "2.0",
            id: `stdio-${Date.now()}`,
            method: "tools/call",
            params: { name: toolName, arguments: toolArgs },
          });

          // The server returns { result: { content: [...], isError } }
          const content = result?.result?.content ?? result?.content ?? [];
          const isError = result?.result?.isError ?? result?.isError ?? false;

          send({
            jsonrpc: "2.0",
            id,
            result: { content, isError },
          });
          break;
        }

        default: {
          send({
            jsonrpc: "2.0",
            id,
            error: { code: -32601, message: `Method not found: ${req.method}` },
          });
        }
      }
    } catch (e: any) {
      send({
        jsonrpc: "2.0",
        id,
        error: { code: -32603, message: e.message || "Internal error" },
      });
    }
  }

  log("Starting stdio MCP server...");
  log(`API: ${baseUrl || "https://api.cognitum.one"}`);

  const rl = createInterface({ input: process.stdin, terminal: false });

  rl.on("line", async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    try {
      const req = JSON.parse(trimmed) as JsonRpcRequest;
      await handleRequest(req);
    } catch {
      send({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      });
    }
  });

  rl.on("close", () => {
    log("stdin closed, exiting");
    process.exit(0);
  });

  // Keep alive
  await new Promise(() => {});
}
