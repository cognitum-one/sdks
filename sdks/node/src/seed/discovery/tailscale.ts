/**
 * `TailscaleDiscovery` — opt-in Tailscale-native provider
 * (ADR-0016a §D6, closes OQ-11).
 *
 * Shells out to `tailscale status --json`, iterates the `Peer` map, and
 * returns the subset whose hostname matches a configurable prefix
 * (default `"cognitum-"`) or a caller-supplied predicate. Each kept
 * peer becomes a {@link DiscoveredPeer} with
 * `url = "https://<DNSName>:<port>"`.
 *
 * The seed does not advertise a `device_id` or `tls_fingerprint` via
 * the tailnet, so both stay `undefined`. Callers that also want
 * per-peer TLS pinning should combine this provider with `mdns.ts`
 * (via a fallback chain) or supply `tls.ca` on the client.
 *
 * No new dependency: shells out via `node:child_process.execFile`,
 * which is available on every supported Node runtime. The Tailscale
 * CLI binary is assumed to be on PATH; on Windows the command is
 * `tailscale.exe`, which `execFile` resolves automatically.
 */

import type { DiscoveryProvider, DiscoveredPeer } from "./types.js";
import { ConfigError } from "../../errors.js";

// Node built-ins used below. Declared rather than imported so the
// `tsup --dts` pass — which runs without `@types/node` in lib — still
// emits types cleanly. Mirrors the pattern used across `src/seed/*.ts`.
declare function require(name: string): unknown;

/** Shape of one peer in `tailscale status --json`. */
interface TailscalePeer {
  /** Short hostname, e.g. `cognitum-61bc`. */
  HostName?: string;
  /** Fully-qualified DNS name, e.g. `cognitum-61bc.tail1234.ts.net.`. */
  DNSName?: string;
  /** Whether tailnet considers this peer reachable. */
  Online?: boolean;
}

/** Relevant slice of `tailscale status --json`. */
interface TailscaleStatus {
  Peer?: Record<string, TailscalePeer>;
  Self?: TailscalePeer;
}

/**
 * Minimal `execFile`-like signature. The real one lives in
 * `node:child_process`; exposed here as a parameter so tests can
 * stub it without fighting the module cache.
 */
export type ExecFileFn = (
  file: string,
  args: readonly string[],
  cb: (
    err: (Error & { code?: string | number }) | null,
    stdout: string,
    stderr: string,
  ) => void,
) => void;

/** Options for {@link TailscaleDiscovery}. */
export interface TailscaleDiscoveryOptions {
  /**
   * Host-name prefix used to filter peers when no `predicate` is given.
   * Defaults to `"cognitum-"` — matches the seed's auto-assigned
   * hostname pattern. Case-insensitive.
   */
  prefix?: string;
  /** TCP port to construct URLs with. Defaults to `8443`. */
  port?: number;
  /** URL scheme. `https` by default. */
  scheme?: "https" | "http";
  /**
   * Path to the `tailscale` binary. Defaults to `"tailscale"` (resolved
   * on PATH). On Windows Node resolves `"tailscale"` to `tailscale.exe`
   * automatically via PATHEXT.
   */
  command?: string;
  /**
   * Custom filter invoked for each tailnet peer. When supplied, it
   * replaces the prefix check entirely — the prefix is only consulted
   * when this is `undefined`.
   */
  predicate?: (peer: TailscalePeer) => boolean;
  /**
   * Inject a stub `execFile` for tests / callers that already wrap the
   * Tailscale CLI. Defaults to `require("node:child_process").execFile`.
   */
  execFile?: ExecFileFn;
}

const DEFAULT_PREFIX = "cognitum-";
const DEFAULT_PORT = 8443;
const DEFAULT_COMMAND = "tailscale";

/**
 * Opt-in Tailscale discovery provider. Returns peers from the local
 * tailnet whose hostname starts with the configured prefix.
 *
 * @example
 * ```ts
 * import { SeedClient } from "@cognitum/sdk/seed";
 * import { TailscaleDiscovery } from "@cognitum/sdk/seed/discovery/tailscale";
 *
 * const client = await SeedClient.create({
 *   endpoints: new TailscaleDiscovery({ prefix: "cognitum-" }),
 *   tls: { insecure: true }, // tailnet carries no cert fingerprint today
 * });
 * ```
 */
export class TailscaleDiscovery implements DiscoveryProvider {
  private readonly prefix: string;
  private readonly port: number;
  private readonly scheme: "https" | "http";
  private readonly command: string;
  private readonly predicate: ((peer: TailscalePeer) => boolean) | undefined;
  private readonly execFile: ExecFileFn | undefined;

  constructor(opts: TailscaleDiscoveryOptions = {}) {
    const port = opts.port ?? DEFAULT_PORT;
    if (!Number.isFinite(port) || port <= 0 || port > 65535) {
      throw new ConfigError(
        `TailscaleDiscovery.port must be a TCP port in 1..65535 (got ${port})`,
      );
    }
    this.prefix = (opts.prefix ?? DEFAULT_PREFIX).toLowerCase();
    this.port = port;
    this.scheme = opts.scheme ?? "https";
    this.command = opts.command ?? DEFAULT_COMMAND;
    this.predicate = opts.predicate;
    this.execFile = opts.execFile;
  }

  async discover(): Promise<DiscoveredPeer[]> {
    const exec = this.execFile ?? (await loadExecFile());
    const stdout = await runTailscale(exec, this.command);
    const status = parseStatus(stdout);
    const peers: TailscalePeer[] = [];
    if (status.Peer) {
      for (const p of Object.values(status.Peer)) peers.push(p);
    }
    if (status.Self) peers.push(status.Self);

    const seen = new Map<string, DiscoveredPeer>();
    for (const p of peers) {
      if (!this.keep(p)) continue;
      const host = pickHost(p);
      if (!host) continue;
      const url = `${this.scheme}://${host}:${this.port}`;
      if (!seen.has(url)) seen.set(url, { url });
    }
    return Array.from(seen.values());
  }

  private keep(p: TailscalePeer): boolean {
    if (this.predicate) return this.predicate(p);
    const candidate = (p.HostName ?? p.DNSName ?? "").toLowerCase();
    return candidate.startsWith(this.prefix);
  }
}

// ---------------------------------------------------------------------- //
// internals                                                               //
// ---------------------------------------------------------------------- //

/** Strip the trailing dot from a DNS name; return the short HostName otherwise. */
function pickHost(p: TailscalePeer): string | undefined {
  const dns = p.DNSName?.trim();
  if (dns) {
    const stripped = dns.replace(/\.$/, "");
    if (stripped) return stripped;
  }
  const h = p.HostName?.trim();
  return h ? h : undefined;
}

function parseStatus(raw: string): TailscaleStatus {
  try {
    const obj = JSON.parse(raw) as unknown;
    if (obj === null || typeof obj !== "object") {
      throw new Error("not an object");
    }
    return obj as TailscaleStatus;
  } catch (err) {
    throw new ConfigError(
      `TailscaleDiscovery: failed to parse \`tailscale status --json\` output: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

function runTailscale(exec: ExecFileFn, command: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    try {
      exec(command, ["status", "--json"], (err, stdout, stderr) => {
        if (err) {
          const code = (err as { code?: string | number }).code;
          if (code === "ENOENT") {
            reject(
              new ConfigError(
                `TailscaleDiscovery: \`${command}\` not found on PATH. ` +
                  `Install the Tailscale CLI (https://tailscale.com/download) ` +
                  `or pass \`command\` with an absolute path.`,
              ),
            );
            return;
          }
          reject(
            new ConfigError(
              `TailscaleDiscovery: \`${command} status --json\` failed: ` +
                `${err.message}${stderr ? ` — stderr: ${stderr.trim()}` : ""}`,
            ),
          );
          return;
        }
        resolve(stdout);
      });
    } catch (err) {
      reject(
        new ConfigError(
          `TailscaleDiscovery: unable to spawn \`${command}\`: ${
            err instanceof Error ? err.message : String(err)
          }`,
        ),
      );
    }
  });
}

/**
 * Resolve `child_process.execFile` at call time. Done lazily so
 * bundlers that target non-Node environments don't fail on the
 * `node:child_process` specifier at build time.
 */
async function loadExecFile(): Promise<ExecFileFn> {
  try {
    // Indirected through a string var so tsc/tsup don't attempt static
    // resolution when the output target is a non-Node runtime.
    const spec = "node:child_process";
    const mod = (await import(spec)) as { execFile?: ExecFileFn };
    if (typeof mod.execFile !== "function") {
      throw new Error("child_process.execFile is unavailable");
    }
    return mod.execFile;
  } catch (err) {
    throw new ConfigError(
      `TailscaleDiscovery requires Node's \`child_process\` module, which ` +
        `is unavailable in this runtime: ${
          err instanceof Error ? err.message : String(err)
        }`,
    );
  }
}
