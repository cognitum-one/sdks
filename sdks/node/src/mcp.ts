import type { HttpClient } from "./client.js";
import type { McpTool, McpToolCallResult, SearchResult } from "./types.js";

/** Interact with the MCP (Model Context Protocol) server. */
export class McpResource {
  constructor(private readonly client: HttpClient) {}

  /** List all available MCP tools. */
  async listTools(): Promise<McpTool[]> {
    return this.client.request<McpTool[]>("GET", "/apiMcpTools");
  }

  /**
   * Call an MCP tool by name with the given arguments.
   * Uses JSON-RPC format over the SSE endpoint.
   */
  async callTool(
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<McpToolCallResult> {
    return this.client.request<McpToolCallResult>("POST", "/mcpSse", {
      jsonrpc: "2.0",
      id: crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`,
      method: "tools/call",
      params: { name, arguments: args },
    });
  }

  /** Search the documentation knowledge base. */
  async searchDocs(
    query: string,
    limit = 5,
  ): Promise<SearchResult[]> {
    const result = await this.callTool("docs_search", { query, limit });
    // MCP response is { result: { content: [...] } } — handle both nested and flat
    const content = result?.result?.content ?? result?.content ?? [];
    const textContent = Array.isArray(content)
      ? content.find((c: any) => c.type === "text")
      : undefined;
    if (textContent?.text) {
      try {
        return JSON.parse(textContent.text) as SearchResult[];
      } catch {
        return [];
      }
    }
    return [];
  }
}
