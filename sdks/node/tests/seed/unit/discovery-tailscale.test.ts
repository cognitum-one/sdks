/**
 * `TailscaleDiscovery` unit tests (ADR-0016a §D6, closes OQ-11).
 *
 * These stub `child_process.execFile` via the `execFile` option so no
 * real `tailscale` binary is invoked. Fixture JSON mirrors the relevant
 * slice of `tailscale status --json` on a tailnet that includes a pair
 * of cognitum seeds plus unrelated noise (a laptop, a router).
 */

import { describe, it, expect } from "vitest";
import {
  TailscaleDiscovery,
  type ExecFileFn,
} from "../../../src/seed/discovery/tailscale.js";
import { ConfigError } from "../../../src/errors.js";

const FIXTURE_STATUS = JSON.stringify({
  Self: {
    HostName: "ruvultra",
    DNSName: "ruvultra.tail1234.ts.net.",
    Online: true,
  },
  Peer: {
    nodekey_a: {
      HostName: "cognitum-61bc",
      DNSName: "cognitum-61bc.tail1234.ts.net.",
      Online: true,
    },
    nodekey_b: {
      HostName: "cognitum-aaaa",
      DNSName: "cognitum-aaaa.tail1234.ts.net.",
      Online: true,
    },
    nodekey_c: {
      HostName: "laptop-joe",
      DNSName: "laptop-joe.tail1234.ts.net.",
      Online: true,
    },
    nodekey_d: {
      HostName: "router-home",
      DNSName: "router-home.tail1234.ts.net.",
      Online: false,
    },
  },
});

/** Build an `execFile` stub that yields the given stdout/stderr/err shape. */
function makeExec(opts: {
  stdout?: string;
  stderr?: string;
  err?: Error & { code?: string | number };
}): { exec: ExecFileFn; calls: Array<{ file: string; args: readonly string[] }> } {
  const calls: Array<{ file: string; args: readonly string[] }> = [];
  const exec: ExecFileFn = (file, args, cb) => {
    calls.push({ file, args });
    // Callback on next tick to mirror real async behaviour.
    setImmediate(() => cb(opts.err ?? null, opts.stdout ?? "", opts.stderr ?? ""));
  };
  return { exec, calls };
}

describe("TailscaleDiscovery (ADR-0016a §D6, OQ-11)", () => {
  it("filters peers by default `cognitum-` prefix and maps to https URLs", async () => {
    const { exec, calls } = makeExec({ stdout: FIXTURE_STATUS });
    const discovery = new TailscaleDiscovery({ execFile: exec });
    const peers = await discovery.discover();

    expect(peers.map((p) => p.url).sort()).toEqual([
      "https://cognitum-61bc.tail1234.ts.net:8443",
      "https://cognitum-aaaa.tail1234.ts.net:8443",
    ]);
    for (const p of peers) {
      expect(p.deviceId).toBeUndefined();
      expect(p.tlsFingerprint).toBeUndefined();
    }
    // Exactly one `tailscale status --json` invocation.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      file: "tailscale",
      args: ["status", "--json"],
    });
  });

  it("honours a custom predicate and port override", async () => {
    const { exec } = makeExec({ stdout: FIXTURE_STATUS });
    const discovery = new TailscaleDiscovery({
      execFile: exec,
      port: 18443,
      // Keep only the first `cognitum-` peer; drop everything else.
      predicate: (p) => p.HostName === "cognitum-61bc",
    });
    const peers = await discovery.discover();

    expect(peers).toHaveLength(1);
    expect(peers[0].url).toBe("https://cognitum-61bc.tail1234.ts.net:18443");
  });

  it("raises ConfigError when the `tailscale` binary is missing", async () => {
    const err = Object.assign(new Error("spawn tailscale ENOENT"), {
      code: "ENOENT",
    });
    const { exec } = makeExec({ err });
    const discovery = new TailscaleDiscovery({ execFile: exec });
    await expect(discovery.discover()).rejects.toBeInstanceOf(ConfigError);
    await expect(discovery.discover()).rejects.toMatchObject({
      message: expect.stringContaining("not found on PATH"),
    });
  });

  it("raises ConfigError on malformed JSON output", async () => {
    const { exec } = makeExec({ stdout: "this is not json" });
    const discovery = new TailscaleDiscovery({ execFile: exec });
    await expect(discovery.discover()).rejects.toBeInstanceOf(ConfigError);
    await expect(discovery.discover()).rejects.toMatchObject({
      message: expect.stringContaining("failed to parse"),
    });
  });
});
