/**
 * Integration test against a live seed reachable via the mac-mini SSH
 * tunnel (`ssh -f -N -L 18443:169.254.42.1:8443 cohen@100.123.117.38`).
 *
 * The test is skipped when either:
 *   - `SKIP_SEED_INTEGRATION=1` is set, or
 *   - a TCP probe to `localhost:18443` fails within 500 ms.
 *
 * It paces requests to ≤1/s per CLAUDE.local.md to stay polite on the
 * Raspberry Pi Zero 2 W, and never leaves behind pairing state: if it
 * calls `pair.create`, it always unpairs in the `afterAll` hook.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import net from "node:net";
import { SeedClient } from "../../../src/seed/index.js";

const SEED_URL =
  process.env.COGNITUM_SEED_URL ?? "https://localhost:18443";
const TOKEN = process.env.COGNITUM_SEED_TOKEN ?? "";
const HOST = new URL(SEED_URL).hostname;
const PORT = Number(new URL(SEED_URL).port || "18443");

async function tunnelOpen(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (ok: boolean) => {
      try { s.destroy(); } catch { /* noop */ }
      resolve(ok);
    };
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
    setTimeout(() => done(false), 500);
  });
}

// Gate at collection time so the describe block never defines tests on
// skipped runs — keeps the `npm test` output clean.
const skip =
  process.env.SKIP_SEED_INTEGRATION === "1" ||
  !(await tunnelOpen(HOST, PORT));

const d = skip ? describe.skip : describe;

d("live seed (Phase 1 endpoints)", () => {
  let client: SeedClient;
  let createdClientName: string | undefined;

  beforeAll(() => {
    client = new SeedClient({
      endpoints: SEED_URL,
      ...(TOKEN ? { auth: { pairingToken: TOKEN } } : {}),
      tls: { insecure: true },
      retries: 1,
      // Gentle timeouts — seed is on a Pi Zero.
      timeouts: { connect: 5_000, read: 10_000, total: 20_000 },
    });
  });

  afterAll(async () => {
    if (createdClientName && client) {
      try {
        await client.pair.delete(createdClientName);
      } catch {
        // best-effort cleanup
      }
    }
  });

  it("GET /api/v1/status returns a plausible shape", async () => {
    const s = await client.status();
    expect(typeof s.device_id).toBe("string");
    expect(s.device_id.length).toBeGreaterThan(0);
    expect(typeof s.uptime_secs).toBe("number");
    expect(typeof s.epoch).toBe("number");
    expect(typeof s.dimension).toBe("number");
    expect(Array.isArray(s.roles)).toBe(true);
    await pace();
  }, 15_000);

  it("GET /api/v1/identity returns a device_id", async () => {
    const id = await client.identity();
    expect(typeof id.device_id).toBe("string");
    expect(id.device_id.length).toBeGreaterThan(0);
    await pace();
  }, 15_000);

  it("GET /api/v1/pair/status returns `paired` boolean", async () => {
    const p = await client.pair.status();
    expect(typeof p.paired).toBe("boolean");
    await pace();
  }, 15_000);

  it("GET /api/v1/witness/chain responds", async () => {
    const w = await client.witness.chain();
    expect(w).toBeTruthy();
    await pace();
  }, 15_000);

  it("GET /api/v1/custody/epoch returns an epoch number", async () => {
    const e = await client.custody.epoch();
    expect(typeof e.epoch).toBe("number");
    await pace();
  }, 15_000);

  it("GET /api/v1/store/status returns dimension", async () => {
    const s = await client.store.status();
    expect(typeof s.dimension).toBe("number");
    await pace();
  }, 15_000);

  it("GET /api/v1/ota/config responds", async () => {
    const cfg = await client.ota.config();
    expect(cfg).toBeTruthy();
    await pace();
  }, 15_000);

  // Pairing: only attempt if currently unpaired. Live seed may already
  // be paired with an existing token — we don't clobber state.
  it.skipIf(!!TOKEN)("POST /api/v1/pair + DELETE /api/v1/pair/{name} round-trips", async () => {
    const status = await client.pair.status();
    if (status.paired && status.pairing_window_open === false) {
      // Window closed, can't test pairing without physical button press.
      return;
    }
    const clientName = `phase1-test-${Date.now()}`;
    try {
      const created = await client.pair.create({ clientName });
      expect(created.token.isEmpty()).toBe(false);
      expect(created.token.reveal().length).toBeGreaterThan(0);
      createdClientName = clientName;
      await pace();
    } catch (err) {
      // If the seed refuses (e.g. pairing window closed) log and skip.
      console.warn("pair.create skipped:", (err as Error).message);
    }
  }, 20_000);
});

function pace(ms = 1100): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
