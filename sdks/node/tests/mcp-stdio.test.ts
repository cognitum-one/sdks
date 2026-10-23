import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const { request, create } = vi.hoisted(() => ({ request: vi.fn(), create: vi.fn() }));
vi.mock("node:readline", () => ({ createInterface: create }));
vi.mock("../src/client.js", () => ({ HttpClient: class { request = request; } }));
import { startStdioServer } from "../src/mcp-stdio.js";
let rl: EventEmitter;
let out: string[];
let err: string[];
async function send(value: unknown) {
  const line = typeof value === "string" ? value : JSON.stringify(value);
  await rl.listeners("line")[0](line);
  return out.length ? JSON.parse(out[out.length - 1]) : undefined;
}
beforeEach(() => {
  rl = new EventEmitter();out = [];err = [];request.mockReset();create.mockReset().mockReturnValue(rl);
  vi.spyOn(process.stdout, "write").mockImplementation((s) => { out.push(String(s));return true; });
  vi.spyOn(process.stderr, "write").mockImplementation((s) => { err.push(String(s));return true; });
});
afterEach(() => vi.restoreAllMocks());
describe("stdio JSON-RPC boundaries", () => {
  it("initializes, acknowledges requests, and ignores notifications/empty input", async () => {
    void startStdioServer("fixture");
    expect(create).toHaveBeenCalledWith({ input: process.stdin, terminal: false });
    await send("   "); await send({ method: "notifications/initialized" }); await send({ method: "initialized" });expect(out).toHaveLength(0);
    expect(await send({ id: 1, method: "initialize" })).toMatchObject({ id: 1, result: { protocolVersion: "2024-11-05", serverInfo: { name: "cognitum" } } });
    expect(await send({ id: 2, method: "initialized" })).toEqual({ jsonrpc: "2.0", id: 2, result: {} });
  });
  it("returns parse and unknown-method errors without proxy I/O", async () => {
    void startStdioServer("fixture", "http://127.0.0.1:1234");
    expect(await send("{broken")).toMatchObject({ id: null, error: { code: -32700 } });
    expect(await send({ id: 0, method: "unknown" })).toMatchObject({ id: 0, error: { code: -32601 } });expect(request).not.toHaveBeenCalled();
  });
  it.each([{ tools: [{ name: "health" }] }, [{ name: "health" }], null])("caches successful tool-list response %j", async result => {
    request.mockResolvedValue(result);void startStdioServer("fixture");
    const response = await send({ id: "first", method: "tools/list" });expect(response.result.tools).toEqual(result?.tools ?? result ?? []);
    await send({ id: "second", method: "tools/list" });expect(request).toHaveBeenCalledTimes(result === null ? 2 : 1);
  });
  it("does not cache a failing tool fetch and keeps diagnostics on stderr", async () => {
    request.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({ tools: [{ name: "recovered" }] });void startStdioServer("fixture");
    expect(await send({ id: 1, method: "tools/list" })).toMatchObject({ result: { tools: [] } });
    expect(await send({ id: 2, method: "tools/list" })).toMatchObject({ result: { tools: [{ name: "recovered" }] } });expect(err.join(" ")).toContain("Failed to fetch tools: offline");
  });
  it("rejects missing tool names before I/O", async () => {
    void startStdioServer("fixture");
    expect(await send({ id: 1, method: "tools/call" })).toMatchObject({ error: { code: -32602 } });
    expect(await send({ id: 2, method: "tools/call", params: {} })).toMatchObject({ error: { code: -32602 } });expect(request).not.toHaveBeenCalled();
  });
  it.each([
    [{ result: { content: [{ type: "text", text: "ok" }], isError: true } }, { content: [{ type: "text", text: "ok" }], isError: true }],
    [{ content: [], isError: false }, { content: [], isError: false }],
    [undefined, { content: [], isError: false }],
  ])("unwraps nested and flat call responses %j", async (response, expected) => {
    request.mockResolvedValue(response);void startStdioServer("fixture");
    expect(await send({ id: 1, method: "tools/call", params: { name: "health", arguments: { limit: 2 } } })).toMatchObject({ result: expected });
    expect(request).toHaveBeenCalledWith("POST", "/mcpSse", expect.objectContaining({ params: { name: "health", arguments: { limit: 2 } } }));
  });
  it.each([new Error("offline"), {}])("turns proxy failures into RPC errors %j", async failure => {
    request.mockRejectedValue(failure);void startStdioServer("fixture");
    expect(await send({ id: 1, method: "tools/call", params: { name: "health" } })).toMatchObject({ error: { code: -32603, message: failure instanceof Error ? "offline" : "Internal error" } });
    expect(request.mock.calls[0][2].params.arguments).toEqual({});
  });
  it("exits when stdin closes", () => {
    vi.spyOn(process, "exit").mockImplementation(() => undefined as never);void startStdioServer("fixture");rl.emit("close");expect(process.exit).toHaveBeenCalledWith(0);expect(err.join(" ")).toContain("stdin closed");
  });
});
