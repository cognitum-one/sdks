import { describe, it, expect, afterEach, vi } from "vitest";

import { UnsupportedRuntimeError } from "../src/agentic/index.js";
import { MetaProxyClient } from "../src/meta-proxy/client.js";
import { assertNodeRuntime, isBrowserLikeRuntime } from "../src/meta-proxy/browser-guard.js";

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

describe("MetaProxyClient construction — browser-runtime rejection (ADR-0025a §D10, ADR-0029 §D2)", () => {
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
      expect((err as UnsupportedRuntimeError).product).toBe("meta-proxy");
      expect((err as UnsupportedRuntimeError).retryable).toBe(false);
    }
  });

  it("MetaProxyClient construction throws UnsupportedRuntimeError BEFORE reading a credential or opening a socket, when `window` is present", () => {
    g.window = {};
    const fetchSpy = vi.fn();
    const credentialAcquire = vi.fn();

    expect(
      () =>
        new MetaProxyClient({
          transport: fetchSpy as unknown as typeof fetch,
          localCredentialProvider: {
            acquire: credentialAcquire,
            invalidate: vi.fn(),
            describeAuthority: vi.fn(),
            identity: () => "spy",
          },
        }),
    ).toThrow(UnsupportedRuntimeError);

    // Neither the transport nor the credential provider was ever touched.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(credentialAcquire).not.toHaveBeenCalled();
  });

  it("MetaProxyClient construction throws UnsupportedRuntimeError when `document` is present", () => {
    g.document = {};
    expect(() => new MetaProxyClient()).toThrow(UnsupportedRuntimeError);
  });

  it("the runtime guard fires BEFORE config validation would otherwise throw a different error", () => {
    g.window = {};
    // An invalid, non-loopback origin would normally throw a plain
    // TypeError from resolveMetaProxyClientConfig — but the browser guard
    // must win first, since it is checked before config resolution at all.
    expect(() => new MetaProxyClient({ origin: "http://example.com:11435" })).toThrow(
      UnsupportedRuntimeError,
    );
  });

  it("construction succeeds normally once the browser-like globals are removed", () => {
    g.window = {};
    expect(() => new MetaProxyClient()).toThrow(UnsupportedRuntimeError);
    restoreGlobals();
    expect(() => new MetaProxyClient()).not.toThrow();
  });
});
