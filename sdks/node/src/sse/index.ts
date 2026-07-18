/**
 * Protocol-agnostic Server-Sent Events parsing (ADR-0024a §D5). Public
 * barrel for `./parser.js` — no Meta-LLM (or any other product) knowledge
 * lives here; this is reused as-is by every streaming protocol facade.
 */

export type { SseEvent, SseParserOptions, SseParserFinishResult } from "./parser.js";
export { SseParser, SseParseError } from "./parser.js";
