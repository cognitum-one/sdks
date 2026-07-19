import { describe, it, expect, afterEach, vi } from "vitest";

import { UnsupportedRuntimeError } from "../src/agentic/index.js";
import { MetaHarnessClient } from "../src/metaharness/client.js";
import { assertNodeRuntime, isBrowserLikeRuntime } from "../src/metaharness/browser-guard.js";

type MutableGlobal = typeof globalThis & Record<string, unknown>;
const g = globalThis as MutableGlobal;

const originalWindow = g.window;
const originalDocument = g.document;
const originalProcess = g.process;

function restoreGlobals(): void {
  if (originalWindow === undefined) delete g.window;
  else g.window = originalWindow;
  if (originalDocument === undefined) delete g.document;
  else g.document = originalDocument;
  g.process = originalProcess;
}

describe("MetaHarnessClient construction — browser-runtime rejection (ADR-0026a §D1, ADR-0029 §D2)", () => {
  afterEach(() => {
    restoreGlobals();
  });

  it("isBrowserLikeRuntime() is false under the normal Node test runtime", () => {
    expect(isBrowserLikeRuntime()).toBe(false);
  });

  it("detects a browser-like runtime via presence of `window`", () => {
    g.window = {};
    expect(isBrowserLikeRuntime()).toBe(true);
  });

  it("detects a browser-like runtime via presence of `document`", () => {
    g.document = {};
    expect(isBrowserLikeRuntime()).toBe(true);
  });

  it("detects a browser-like runtime via absence of process.versions.node", () => {
    g.process = { ...(originalProcess as object), versions: {} } as NodeJS.Process;
    expect(isBrowserLikeRuntime()).toBe(true);
  });

  it("assertNodeRuntime() throws UnsupportedRuntimeError with runtime 'browser' when window is present", () => {
    g.window = {};
    expect(() => assertNodeRuntime("construct")).toThrow(UnsupportedRuntimeError);
    try {
      assertNodeRuntime("construct");
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(UnsupportedRuntimeError);
      expect((err as UnsupportedRuntimeError).runtime).toBe("browser");
      expect((err as UnsupportedRuntimeError).kind).toBe("configuration");
      expect((err as UnsupportedRuntimeError).product).toBe("metaharness");
      expect((err as UnsupportedRuntimeError).retryable).toBe(false);
    }
  });

  it("MetaHarnessClient construction throws UnsupportedRuntimeError BEFORE reading any config field, when `window` is present", () => {
    g.window = {};
    const distributionGetter = vi.fn(() => ({ registry: "https://registry.npmjs.org" }));

    expect(
      () =>
        new MetaHarnessClient({
          get distribution() {
            return distributionGetter();
          },
        } as unknown as ConstructorParameters<typeof MetaHarnessClient>[0]),
    ).toThrow(UnsupportedRuntimeError);

    // The config object's `distribution` getter was never touched — proof
    // the guard fires before config resolution reads any field.
    expect(distributionGetter).not.toHaveBeenCalled();
  });

  it("MetaHarnessClient construction throws UnsupportedRuntimeError when `document` is present", () => {
    g.document = {};
    expect(() => new MetaHarnessClient()).toThrow(UnsupportedRuntimeError);
  });

  it("the runtime guard fires BEFORE config validation would otherwise throw a different error", () => {
    g.window = {};
    // An invalid handshakeTimeoutMs would normally throw a plain TypeError
    // from resolveMetaHarnessClientConfig — but the browser guard must win
    // first, since it is checked before config resolution at all.
    expect(() => new MetaHarnessClient({ handshakeTimeoutMs: -1 })).toThrow(
      UnsupportedRuntimeError,
    );
  });

  it("construction succeeds normally once the browser-like globals are removed", () => {
    g.window = {};
    expect(() => new MetaHarnessClient()).toThrow(UnsupportedRuntimeError);
    restoreGlobals();
    expect(() => new MetaHarnessClient()).not.toThrow();
  });
});
