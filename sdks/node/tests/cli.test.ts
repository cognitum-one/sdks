import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { request, stdio } = vi.hoisted(() => ({ request: vi.fn(), stdio: vi.fn() }));
vi.mock("../src/client.js", () => ({ HttpClient: class { request = request; } }));
vi.mock("../src/mcp-stdio.js", () => ({ startStdioServer: stdio }));

class Exit extends Error { constructor(readonly code: number) { super(`exit ${code}`); } }
let log: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("__SDK_VERSION__", "migration-test");
  vi.stubEnv("COGNITUM_API_KEY", "");
  log = vi.spyOn(console, "log").mockImplementation(() => {});
  error = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process, "exit").mockImplementation((code) => { throw new Exit(Number(code)); });
  request.mockReset(); stdio.mockReset();
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
const run = async (...args: string[]) => (await import("../src/cli.js")).main(args);

describe("CLI command boundaries", () => {
  it.each(["--version", "-v"])("prints version via %s without a credential", async flag => {
    await run(flag); expect(log).toHaveBeenCalledWith("migration-test"); expect(request).not.toHaveBeenCalled();
  });
  it.each(["--help", "-h"])("exits help successfully via %s", async flag => {
    await expect(run("health", flag)).rejects.toMatchObject({ code: 0 });
    expect(log.mock.calls.flat().join(" ")).toContain("Usage: cognitum");
  });
  it("refuses missing credentials before I/O", async () => {
    await expect(run("health")).rejects.toMatchObject({ code: 1 });
    expect(error).toHaveBeenCalledWith(expect.stringContaining("API key required")); expect(request).not.toHaveBeenCalled();
  });
  it("prints key-management URL without credentials", async () => {
    await run("keys"); expect(log.mock.calls.flat().join(" ")).toContain("https://manage.cognitum.one/api-keys");
  });
  it("hands MCP mode the explicit key and base URL", async () => {
    await run("mcp", "-k", "fixture-key", "--base-url", "http://127.0.0.1:1234");
    expect(stdio).toHaveBeenCalledWith("fixture-key", "http://127.0.0.1:1234"); expect(request).not.toHaveBeenCalled();
  });
  it("uses the environment credential and prints health JSON", async () => {
    vi.stubEnv("COGNITUM_API_KEY", "fixture-key");request.mockResolvedValue({ status: "ok" });
    await run("health", "--json"); expect(request).toHaveBeenCalledWith("GET", "/apiHealth"); expect(log).toHaveBeenCalledWith('{\n  "status": "ok"\n}');
  });
  it("prints human-readable health fields", async () => {
    request.mockResolvedValue({ status: "ok", version: "v1", timestamp: "now" }); await run("health", "--key", "fixture");
    expect(log).toHaveBeenCalledWith("Status:    ok"); expect(log).toHaveBeenCalledWith("Timestamp: now");
  });
  it.each([{}, { products: [] }, { products: [{ name: "Seed", price: 1200, available: true }, { name: "Future", available: false }] }])("handles catalog presentation %j", async result => {
    request.mockResolvedValue(result); await run("catalog", "--key", "fixture");
    expect(request).toHaveBeenCalledWith("GET", "/apiCatalog");
    const output = log.mock.calls.flat().join(" ");
    expect(output).toBe("products" in result && result.products?.length ? "Seed  $12  available Future  N/A  coming soon" : "No products found.");
  });
  it("retains raw catalog JSON", async () => { request.mockResolvedValue({ products: [] }); await run("catalog", "-k", "fixture", "--json"); expect(log).toHaveBeenCalledWith('{\n  "products": []\n}'); });
  it.each([{ tools: [{ name: "health", description: "Health" }, {}] }, [{ name: "health" }]])("lists tools in supported response shapes %j", async result => {
    request.mockResolvedValue(result); await run("tools", "-k", "fixture"); expect(log.mock.calls.flat().join(" ")).toContain("health");
  });
  it("prints an empty tool list as JSON", async () => { request.mockResolvedValue([]); await run("tools", "-k", "fixture", "--json");expect(log).toHaveBeenCalledWith("[]"); });
  it("rejects missing tools and invalid JSON", async () => {
    await expect(run("call", "-k", "fixture")).rejects.toMatchObject({ code: 1 });
    await expect(run("call", "health", "{bad", "-k", "fixture")).rejects.toMatchObject({ code: 1 });expect(request).not.toHaveBeenCalled();
  });
  it.each([
    { result: { content: [{ type: "text", text: '{"ok":true}' }] } },
    { content: [{ type: "text", text: "plain" }, { type: "image" }, { type: "text" }] },
    { content: "invalid" }, {}, null,
  ])("handles tool content without leaking response wrappers %j", async response => {
    request.mockResolvedValue(response); await run("call", "health", "-k", "fixture");expect(request).toHaveBeenCalledWith("POST", "/mcpSse", expect.objectContaining({ params: { name: "health", arguments: {} } }));
    const expected = response && "result" in response ? ['{\n  "ok": true\n}'] : response && Array.isArray(response.content) ? ["plain"] : [];
    expect(log.mock.calls.map(([value]) => value)).toEqual(expected);
  });
  it("preserves explicit tool arguments and raw JSON mode", async () => {
    request.mockResolvedValue({ ok: true }); await run("call", "health", '{"limit":2}', "-k", "fixture", "--json");expect(request).toHaveBeenCalledWith("POST", "/mcpSse", expect.objectContaining({ params: { name: "health", arguments: { limit: 2 } } }));expect(log).toHaveBeenCalledWith('{\n  "ok": true\n}');
  });
  it("reports request errors and refuses unknown commands", async () => {
    request.mockRejectedValue(new Error("unavailable"));await expect(run("health", "-k", "fixture")).rejects.toMatchObject({ code: 1 });expect(error).toHaveBeenCalledWith("Error: unavailable");
    await expect(run("unknown", "-k", "fixture")).rejects.toMatchObject({ code: 1 });expect(error).toHaveBeenCalledWith("Unknown command: unknown");
  });
});
