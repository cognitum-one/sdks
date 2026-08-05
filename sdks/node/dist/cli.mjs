#!/usr/bin/env node

// src/errors.ts
var CognitumError = class extends Error {
  /** Machine-readable error code. */
  code;
  /** HTTP status code, if applicable. */
  statusCode;
  constructor(message, code, statusCode) {
    super(message);
    this.name = "CognitumError";
    this.code = code;
    this.statusCode = statusCode;
    Object.setPrototypeOf(this, new.target.prototype);
  }
};
var AuthError = class extends CognitumError {
  constructor(message = "Authentication failed") {
    super(message, "AUTH_ERROR", 401);
    this.name = "AuthError";
  }
};
var RateLimitError = class extends CognitumError {
  /** Milliseconds to wait before retrying, parsed from Retry-After header. */
  retryAfterMs;
  constructor(retryAfterMs = 1e3, message = "Rate limit exceeded") {
    super(message, "RATE_LIMIT", 429);
    this.name = "RateLimitError";
    this.retryAfterMs = retryAfterMs;
  }
};
var ValidationError = class extends CognitumError {
  constructor(message = "Validation failed") {
    super(message, "VALIDATION_ERROR", 400);
    this.name = "ValidationError";
  }
};
var NotFoundError = class extends CognitumError {
  constructor(message = "Resource not found") {
    super(message, "NOT_FOUND", 404);
    this.name = "NotFoundError";
  }
};

// src/client.ts
var DEFAULT_BASE_URL = "https://api.cognitum.one";
var DEFAULT_TIMEOUT = 3e4;
var DEFAULT_RETRIES = 3;
var BASE_MS = 500;
var CAP_MS = 3e4;
var DEFAULT_MAX_ELAPSED_MS = 6e4;
var RETRIABLE_STATUS = /* @__PURE__ */ new Set([429, 500, 502, 503, 504]);
var HttpClient = class {
  apiKey;
  baseUrl;
  timeout;
  retries;
  rateLimitRetry;
  maxElapsedMs;
  constructor(config) {
    const resolved = resolveApiKey(config.apiKey);
    this.apiKey = resolved;
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.timeout = config.timeout ?? DEFAULT_TIMEOUT;
    this.retries = config.retries ?? DEFAULT_RETRIES;
    this.rateLimitRetry = config.rateLimitRetry ?? true;
    this.maxElapsedMs = config.maxElapsedMs ?? DEFAULT_MAX_ELAPSED_MS;
  }
  /**
   * Perform an HTTP request against the Cognitum API.
   *
   * Automatically injects the API key header, serialises JSON bodies,
   * retries on transient errors with equal-jitter back-off per ADR-0005,
   * and maps HTTP error responses to typed SDK errors.
   */
  async request(method, path, body, opts) {
    const url = `${this.baseUrl}${path}`;
    const headers = {
      "X-API-Key": this.apiKey,
      Accept: "application/json"
    };
    const init = { method, headers };
    if (body !== void 0) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    const methodUpper = method.toUpperCase();
    const idempotent = opts?.idempotent ?? methodUpper !== "POST";
    const started = Date.now();
    let lastError;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeout);
      init.signal = controller.signal;
      try {
        const response = await fetch(url, init);
        clearTimeout(timer);
        if (response.ok) {
          if (response.status === 204) {
            return void 0;
          }
          return await response.json();
        }
        const errorBody = await response.text().catch(() => "");
        const errorMessage = tryParseErrorMessage(errorBody) ?? response.statusText;
        switch (response.status) {
          case 401:
          case 403:
            throw new AuthError(errorMessage);
          case 404:
            throw new NotFoundError(errorMessage);
          case 400:
          case 422:
            throw new ValidationError(errorMessage);
          case 429: {
            const retryAfterMs = resolveRetryAfter(response, errorBody);
            const err = new RateLimitError(retryAfterMs, errorMessage);
            if (!this.rateLimitRetry || !canRetry(attempt, this.retries, started, this.maxElapsedMs)) {
              throw err;
            }
            lastError = err;
            await sleep(
              clampToBudget(retryAfterMs, started, this.maxElapsedMs)
            );
            continue;
          }
          default:
            if (RETRIABLE_STATUS.has(response.status) && idempotent && canRetry(attempt, this.retries, started, this.maxElapsedMs)) {
              lastError = new CognitumError(
                errorMessage,
                "SERVER_ERROR",
                response.status
              );
              await sleep(
                clampToBudget(
                  equalJitterBackoff(attempt),
                  started,
                  this.maxElapsedMs
                )
              );
              continue;
            }
            throw new CognitumError(
              errorMessage,
              "SERVER_ERROR",
              response.status
            );
        }
      } catch (error) {
        clearTimeout(timer);
        if (error instanceof AuthError || error instanceof NotFoundError || error instanceof ValidationError) {
          throw error;
        }
        if (error instanceof RateLimitError) {
          throw error;
        }
        if (error instanceof CognitumError && error.code === "SERVER_ERROR") {
          throw error;
        }
        if (error instanceof DOMException && error.name === "AbortError") {
          lastError = new CognitumError("Request timed out", "TIMEOUT");
          if (idempotent && canRetry(attempt, this.retries, started, this.maxElapsedMs)) {
            await sleep(
              clampToBudget(
                equalJitterBackoff(attempt),
                started,
                this.maxElapsedMs
              )
            );
            continue;
          }
          throw lastError;
        }
        if (canRetry(attempt, this.retries, started, this.maxElapsedMs)) {
          lastError = error instanceof Error ? error : new Error(String(error));
          await sleep(
            clampToBudget(
              equalJitterBackoff(attempt),
              started,
              this.maxElapsedMs
            )
          );
          continue;
        }
        if (error instanceof CognitumError) {
          throw error;
        }
        throw new CognitumError(
          error instanceof Error ? error.message : String(error),
          "NETWORK_ERROR"
        );
      }
    }
    throw lastError ?? new CognitumError("Request failed", "UNKNOWN");
  }
};
function resolveApiKey(explicit) {
  if (explicit && explicit.length > 0) return explicit;
  const fromEnv = typeof process !== "undefined" ? process.env?.COGNITUM_API_KEY : void 0;
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  throw new AuthError(
    "apiKey is required \u2014 pass config.apiKey or set COGNITUM_API_KEY"
  );
}
function equalJitterBackoff(attempt) {
  const expo = BASE_MS * 2 ** attempt;
  const jitter = Math.random() * BASE_MS;
  return Math.min(CAP_MS, expo + jitter);
}
function canRetry(attempt, retries, startedAt, maxElapsedMs) {
  if (attempt >= retries) return false;
  return Date.now() - startedAt < maxElapsedMs;
}
function clampToBudget(delayMs, startedAt, maxElapsedMs) {
  const remaining = maxElapsedMs - (Date.now() - startedAt);
  if (remaining <= 0) return 0;
  return Math.max(0, Math.min(delayMs, remaining));
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function resolveRetryAfter(response, body) {
  const fromBody = parseRetryAfterBody(body);
  if (fromBody !== void 0) return fromBody;
  const fromHeader = parseRetryAfterHeader(
    response.headers.get("Retry-After")
  );
  if (fromHeader !== void 0) return fromHeader;
  return 1e3;
}
function parseRetryAfterHeader(h) {
  if (!h) return void 0;
  const seconds = Number(h);
  if (!Number.isNaN(seconds) && seconds >= 0) {
    return Math.round(seconds * 1e3);
  }
  const date = Date.parse(h);
  if (!Number.isNaN(date)) {
    return Math.max(date - Date.now(), 0);
  }
  return void 0;
}
function parseRetryAfterBody(body) {
  if (!body) return void 0;
  try {
    const parsed = JSON.parse(body);
    if (parsed && typeof parsed === "object") {
      if (typeof parsed.retry_after_us === "number") {
        return Math.round(parsed.retry_after_us / 1e3);
      }
      const hints = [parsed.error, parsed.message];
      for (const h of hints) {
        if (typeof h === "string") {
          const n = extractRetryAfterSeconds(h);
          if (n !== void 0) return n;
        }
      }
    }
  } catch {
  }
  return extractRetryAfterSeconds(body);
}
function extractRetryAfterSeconds(text) {
  const m = /retry after (\d+(?:\.\d+)?)\s*s/i.exec(text);
  if (!m) return void 0;
  const seconds = Number(m[1]);
  if (Number.isNaN(seconds) || seconds < 0) return void 0;
  return Math.round(seconds * 1e3);
}
function tryParseErrorMessage(body) {
  if (!body) return void 0;
  try {
    const parsed = JSON.parse(body);
    if (typeof parsed.message === "string") return parsed.message;
    if (typeof parsed.error === "string") return parsed.error;
  } catch {
  }
  return void 0;
}

// src/mcp.ts
var McpResource = class {
  constructor(client) {
    this.client = client;
  }
  client;
  /** List all available MCP tools. */
  async listTools() {
    return this.client.request("GET", "/apiMcpTools");
  }
  /**
   * Call an MCP tool by name with the given arguments.
   * Uses JSON-RPC format over the SSE endpoint.
   */
  async callTool(name, args = {}) {
    return this.client.request("POST", "/mcpSse", {
      jsonrpc: "2.0",
      id: crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`,
      method: "tools/call",
      params: { name, arguments: args }
    });
  }
  /** Search the documentation knowledge base. */
  async searchDocs(query, limit = 5) {
    const result = await this.callTool("docs_search", { query, limit });
    const content = result?.result?.content ?? result?.content ?? [];
    const textContent = Array.isArray(content) ? content.find((c) => c.type === "text") : void 0;
    if (textContent?.text) {
      try {
        return JSON.parse(textContent.text);
      } catch {
        return [];
      }
    }
    return [];
  }
};

// src/catalog.ts
var CatalogResource = class {
  constructor(client) {
    this.client = client;
  }
  client;
  /** Browse available products, optionally filtered by category. */
  async browse(options) {
    const params = new URLSearchParams();
    if (options?.category) {
      params.set("category", options.category);
    }
    const query = params.toString();
    const path = `/apiCatalog${query ? `?${query}` : ""}`;
    return this.client.request("GET", path);
  }
};

// src/mcp-stdio.ts
import { createInterface } from "readline";
var SERVER_INFO = {
  name: "cognitum",
  version: "1.1.0"
};
var CAPABILITIES = {
  tools: { listChanged: false }
};
async function startStdioServer(apiKey, baseUrl) {
  const client = new HttpClient({
    apiKey,
    baseUrl: baseUrl || "https://api.cognitum.one"
  });
  let toolsCache = null;
  function send(response) {
    process.stdout.write(JSON.stringify(response) + "\n");
  }
  function log(...args) {
    process.stderr.write(`[cognitum-mcp] ${args.join(" ")}
`);
  }
  async function getTools() {
    if (toolsCache) return toolsCache;
    try {
      const result = await client.request("GET", "/apiMcpTools");
      toolsCache = result.tools || result || [];
      return toolsCache;
    } catch (e) {
      log("Failed to fetch tools:", e.message);
      return [];
    }
  }
  async function handleRequest(req) {
    const id = req.id ?? null;
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
              capabilities: CAPABILITIES
            }
          });
          break;
        }
        case "initialized": {
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
          const toolName = req.params?.name;
          const toolArgs = req.params?.arguments || {};
          if (!toolName) {
            send({
              jsonrpc: "2.0",
              id,
              error: { code: -32602, message: "Missing tool name" }
            });
            break;
          }
          const result = await client.request("POST", "/mcpSse", {
            jsonrpc: "2.0",
            id: `stdio-${Date.now()}`,
            method: "tools/call",
            params: { name: toolName, arguments: toolArgs }
          });
          const content = result?.result?.content ?? result?.content ?? [];
          const isError = result?.result?.isError ?? result?.isError ?? false;
          send({
            jsonrpc: "2.0",
            id,
            result: { content, isError }
          });
          break;
        }
        default: {
          send({
            jsonrpc: "2.0",
            id,
            error: { code: -32601, message: `Method not found: ${req.method}` }
          });
        }
      }
    } catch (e) {
      send({
        jsonrpc: "2.0",
        id,
        error: { code: -32603, message: e.message || "Internal error" }
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
      const req = JSON.parse(trimmed);
      await handleRequest(req);
    } catch {
      send({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" }
      });
    }
  });
  rl.on("close", () => {
    log("stdin closed, exiting");
    process.exit(0);
  });
  await new Promise(() => {
  });
}

// src/cli.ts
var VERSION = "0.4.0";
function usage() {
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
function parseArgs(argv) {
  const flags = {};
  const positional = [];
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
    flags
  };
}
async function main() {
  const { command, args, flags } = parseArgs(process.argv.slice(2));
  if (flags.version) {
    console.log(VERSION);
    return;
  }
  if (flags.help || !command) {
    usage();
    process.exit(command ? 0 : 1);
  }
  const apiKey = flags.key || process.env.COGNITUM_API_KEY || "";
  const baseUrl = flags.baseUrl || void 0;
  if (!apiKey && command !== "help" && command !== "keys") {
    console.error("Error: API key required. Use --key or set COGNITUM_API_KEY env var.");
    process.exit(1);
  }
  if (command === "mcp") {
    await startStdioServer(apiKey, baseUrl);
    return;
  }
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
        const health = await client.request("GET", "/apiHealth");
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
        const tools = result.tools || result || [];
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
        let toolArgs = {};
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
          const content = result?.result?.content ?? result?.content ?? [];
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
  } catch (e) {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  }
}
main().catch((e) => {
  console.error(`Fatal: ${e.message}`);
  process.exit(1);
});
