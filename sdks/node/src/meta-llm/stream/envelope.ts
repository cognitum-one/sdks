/**
 * `MetaLlmStreamEnvelope<E>` (ADR-0024a §D5's frozen streaming envelope
 * shape) plus a small optional text/tool accumulator over a
 * `chat.completions` event stream (D5 point 2: "an optional text/tool
 * accumulator over that stream").
 */

import type { ChatCompletionUsage } from "../types/openai.js";
import type { MetaLlmReceipt } from "../types/receipt.js";
import type { OpenAiStreamEvent } from "./openai-events.js";

/**
 * Wraps every parsed stream event with sequencing/provenance metadata.
 * Frozen shape per ADR-0024a §D5 — do not add fields without an ADR update.
 */
export interface MetaLlmStreamEnvelope<E> {
  event: E;
  /** 1-based order of this event within one logical stream call. */
  sequence: number;
  /** ISO-8601 timestamp of when this envelope was produced locally. */
  receivedAt: string;
  requestId: string;
  /** The underlying SSE `event:` field name, if any (OpenAI chat completions does not set one). */
  rawEventName?: string;
  /** Fields present on the wire payload that this decoder does not recognize — preserved losslessly. */
  unknownFields?: Record<string, unknown>;
}

/**
 * Accumulates a `chat.completions` stream's role/content/tool-call/finish/
 * usage/receipt facets into one final snapshot. Works identically whether
 * the stream ended successfully or was cut short — the caller absorbs
 * whatever envelopes were yielded before a terminal error and reads
 * `snapshot()` for the partial result (ADR-0024a §D5: partial state is
 * whatever was already delivered through normal iteration, not a
 * separately-reconstructed value).
 */
export class ChatCompletionsStreamAccumulator {
  private role: string | undefined;
  private contentByIndex = new Map<number, string>();
  private toolCallsByIndex = new Map<number, Map<number, { id?: string; name?: string; arguments: string }>>();
  private finishReasonByIndex = new Map<number, string>();
  private usage: ChatCompletionUsage | undefined;
  private receipt: MetaLlmReceipt | undefined;
  private done = false;

  absorb(envelope: MetaLlmStreamEnvelope<OpenAiStreamEvent>): void {
    const event = envelope.event;
    switch (event.type) {
      case "role":
        this.role = event.role;
        break;
      case "content_delta":
        this.contentByIndex.set(event.index, (this.contentByIndex.get(event.index) ?? "") + event.delta);
        break;
      case "tool_call_delta": {
        let byIndex = this.toolCallsByIndex.get(event.index);
        if (!byIndex) {
          byIndex = new Map();
          this.toolCallsByIndex.set(event.index, byIndex);
        }
        const existing = byIndex.get(event.toolCallIndex) ?? { arguments: "" };
        if (event.id) existing.id = event.id;
        if (event.functionName) existing.name = event.functionName;
        if (event.argumentsDelta) existing.arguments += event.argumentsDelta;
        byIndex.set(event.toolCallIndex, existing);
        break;
      }
      case "finish_reason":
        this.finishReasonByIndex.set(event.index, event.finishReason);
        break;
      case "usage":
        this.usage = event.usage;
        break;
      case "receipt":
        this.receipt = event.receipt;
        break;
      case "done":
        this.done = true;
        break;
      default:
        break;
    }
  }

  snapshot(): {
    role?: string;
    contentByChoice: Record<number, string>;
    toolCallsByChoice: Record<number, Array<{ id?: string; name?: string; arguments: string }>>;
    finishReasonByChoice: Record<number, string>;
    usage?: ChatCompletionUsage;
    receipt?: MetaLlmReceipt;
    completed: boolean;
  } {
    const contentByChoice: Record<number, string> = {};
    for (const [index, content] of this.contentByIndex) contentByChoice[index] = content;

    const toolCallsByChoice: Record<number, Array<{ id?: string; name?: string; arguments: string }>> = {};
    for (const [index, byIndex] of this.toolCallsByIndex) {
      toolCallsByChoice[index] = Array.from(byIndex.values());
    }

    const finishReasonByChoice: Record<number, string> = {};
    for (const [index, reason] of this.finishReasonByIndex) finishReasonByChoice[index] = reason;

    return {
      role: this.role,
      contentByChoice,
      toolCallsByChoice,
      finishReasonByChoice,
      usage: this.usage,
      receipt: this.receipt,
      completed: this.done,
    };
  }
}
