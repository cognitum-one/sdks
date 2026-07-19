/**
 * Tests for the telemetry sink/event stubs and D3 attribute constants
 * (ADR-0028 §D1, §D3).
 *
 * Covers:
 * - `NoopTelemetrySink.emit`/`flush` genuinely do nothing and never throw;
 * - every D3 attribute constant is exactly the ADR-cited string;
 * - `TelemetryEvent`/`TraceContext` hold the values assigned to them.
 */

import { describe, it, expect } from "vitest";
import {
  NoopTelemetrySink,
  type TelemetryEvent,
  type TelemetrySink,
  ATTR_CACHE_RESULT,
  ATTR_CONTRACT_VERSION,
  ATTR_ERROR_KIND,
  ATTR_MODEL_ALIAS,
  ATTR_OPERATION,
  ATTR_OPERATION_STATE,
  ATTR_PRODUCT,
  ATTR_PROTOCOL,
  ATTR_REQUEST_ID,
  ATTR_RETRY_COUNT,
  ATTR_ROUTING_PLANE,
  ATTR_ROUTING_REASON,
  ATTR_TENANT_HASH,
  ATTR_TIER,
  EVENT_ARTIFACT_VERIFIED,
  EVENT_BUDGET_COMMITTED,
  EVENT_BUDGET_RELEASED,
  EVENT_BUDGET_RESERVED,
  EVENT_CAPABILITIES_LOADED,
  EVENT_CONSENT_REQUIRED,
  EVENT_EVIDENCE_VERIFIED,
  EVENT_OPERATION_STATE_CHANGED,
  EVENT_OPERATION_WAIT_ENDED,
  EVENT_PROCESS_ENDED,
  EVENT_PROCESS_STARTED,
  EVENT_REQUEST_END,
  EVENT_REQUEST_RETRY_SCHEDULED,
  EVENT_REQUEST_START,
  EVENT_STREAM_END,
  EVENT_STREAM_FIRST_EVENT,
  EVENT_TELEMETRY_DROPPED,
} from "../../src/agentic/telemetry.js";

function makeEvent(overrides: Partial<TelemetryEvent> = {}): TelemetryEvent {
  return {
    name: "request.start",
    timestamp: "2026-07-19T00:00:00Z",
    severity: "info",
    attributes: {},
    measurements: {},
    ...overrides,
  };
}

describe("NoopTelemetrySink", () => {
  it("emit does nothing and never throws", async () => {
    const sink = new NoopTelemetrySink();
    await expect(sink.emit(makeEvent())).resolves.toBeUndefined();
  });

  it("flush resolves immediately and never throws", async () => {
    const sink = new NoopTelemetrySink();
    await expect(sink.flush(5_000)).resolves.toBeUndefined();
  });

  it("is usable through the TelemetrySink interface", async () => {
    const sink: TelemetrySink = new NoopTelemetrySink();
    await sink.emit(makeEvent());
    await sink.flush(0);
  });
});

describe("ADR-0028 §D3 attribute constants", () => {
  it("match the ADR table exactly", () => {
    expect(ATTR_PRODUCT).toBe("cognitum.product");
    expect(ATTR_OPERATION).toBe("cognitum.operation");
    expect(ATTR_PROTOCOL).toBe("cognitum.protocol");
    expect(ATTR_CONTRACT_VERSION).toBe("cognitum.contract.version");
    expect(ATTR_REQUEST_ID).toBe("cognitum.request.id");
    expect(ATTR_TENANT_HASH).toBe("cognitum.tenant.hash");
    expect(ATTR_MODEL_ALIAS).toBe("cognitum.model.alias");
    expect(ATTR_TIER).toBe("cognitum.tier");
    expect(ATTR_ROUTING_PLANE).toBe("cognitum.routing.plane");
    expect(ATTR_ROUTING_REASON).toBe("cognitum.routing.reason");
    expect(ATTR_CACHE_RESULT).toBe("cognitum.cache.result");
    expect(ATTR_OPERATION_STATE).toBe("cognitum.operation.state");
    expect(ATTR_ERROR_KIND).toBe("cognitum.error.kind");
    expect(ATTR_RETRY_COUNT).toBe("cognitum.retry.count");
  });
});

describe("ADR-0028 §D4 event name constants", () => {
  it("match the ADR catalog exactly", () => {
    expect(EVENT_REQUEST_START).toBe("request.start");
    expect(EVENT_REQUEST_RETRY_SCHEDULED).toBe("request.retry_scheduled");
    expect(EVENT_REQUEST_END).toBe("request.end");
    expect(EVENT_STREAM_FIRST_EVENT).toBe("stream.first_event");
    expect(EVENT_STREAM_END).toBe("stream.end");
    expect(EVENT_OPERATION_STATE_CHANGED).toBe("operation.state_changed");
    expect(EVENT_OPERATION_WAIT_ENDED).toBe("operation.wait_ended");
    expect(EVENT_CAPABILITIES_LOADED).toBe("capabilities.loaded");
    expect(EVENT_BUDGET_RESERVED).toBe("budget.reserved");
    expect(EVENT_BUDGET_COMMITTED).toBe("budget.committed");
    expect(EVENT_BUDGET_RELEASED).toBe("budget.released");
    expect(EVENT_CONSENT_REQUIRED).toBe("consent.required");
    expect(EVENT_PROCESS_STARTED).toBe("process.started");
    expect(EVENT_PROCESS_ENDED).toBe("process.ended");
    expect(EVENT_ARTIFACT_VERIFIED).toBe("artifact.verified");
    expect(EVENT_EVIDENCE_VERIFIED).toBe("evidence.verified");
    expect(EVENT_TELEMETRY_DROPPED).toBe("telemetry.dropped");
  });

  it("has exactly seventeen catalog entries", () => {
    const all = [
      EVENT_REQUEST_START,
      EVENT_REQUEST_RETRY_SCHEDULED,
      EVENT_REQUEST_END,
      EVENT_STREAM_FIRST_EVENT,
      EVENT_STREAM_END,
      EVENT_OPERATION_STATE_CHANGED,
      EVENT_OPERATION_WAIT_ENDED,
      EVENT_CAPABILITIES_LOADED,
      EVENT_BUDGET_RESERVED,
      EVENT_BUDGET_COMMITTED,
      EVENT_BUDGET_RELEASED,
      EVENT_CONSENT_REQUIRED,
      EVENT_PROCESS_STARTED,
      EVENT_PROCESS_ENDED,
      EVENT_ARTIFACT_VERIFIED,
      EVENT_EVIDENCE_VERIFIED,
      EVENT_TELEMETRY_DROPPED,
    ];
    expect(all).toHaveLength(17);
    expect(new Set(all).size).toBe(17);
  });
});

describe("TelemetryEvent shape", () => {
  it("holds assigned fields including an optional traceContext", () => {
    const event = makeEvent({
      name: "request.end",
      severity: "warn",
      traceContext: { traceParent: "00-abc-def-01" },
      attributes: { [ATTR_PRODUCT]: "meta-llm" },
      measurements: { [ATTR_RETRY_COUNT]: 2 },
    });
    expect(event.name).toBe("request.end");
    expect(event.severity).toBe("warn");
    expect(event.traceContext?.traceParent).toBe("00-abc-def-01");
    expect(event.attributes[ATTR_PRODUCT]).toBe("meta-llm");
    expect(event.measurements[ATTR_RETRY_COUNT]).toBe(2);
  });

  it("defaults traceContext to undefined and maps to empty objects", () => {
    const event = makeEvent();
    expect(event.traceContext).toBeUndefined();
    expect(event.attributes).toEqual({});
    expect(event.measurements).toEqual({});
  });
});
