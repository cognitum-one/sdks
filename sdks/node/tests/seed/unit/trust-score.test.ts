/**
 * Trust-score 3-strike protection — closes cognitum-one/sdks#16 (Node).
 *
 * ADR-0007 §"Trust-score protection" (OQ-9): the seed locks a client
 * out after 3 consecutive failed auth attempts. The SDK MUST abort on
 * the 3rd consecutive `AuthError` against the same peer to prevent the
 * caller from burning the seed's trust-score budget and triggering
 * lockdown.
 *
 * Contract (per-client, per-peer):
 *   - 401/403 from peer P increments the counter for P
 *   - Any 2xx from peer P resets the counter to 0
 *   - On the 3rd consecutive increment, the SDK throws
 *     `TrustScoreBlockedError` instead of dispatching a 4th call
 *   - The block error is NOT retryable — the failover state machine
 *     must NOT cycle to another peer on it
 *   - Counters are per-peer; a streak on peer-A does not poison peer-B
 *   - Non-auth errors (5xx / 429 / network) do NOT increment the counter
 */

import { describe, it, expect, vi } from "vitest";
import { SeedClient } from "../../../src/seed/index.js";
import {
  AuthError,
  ServiceUnavailableError,
  TrustScoreBlockedError,
} from "../../../src/errors.js";

function authResponse(status: 401 | 403 = 401): Response {
  return {
    ok: false,
    status,
    statusText: `HTTP ${status}`,
    headers: new Headers(),
    json: () => Promise.resolve({ error: "no pairing token" }),
    text: () => Promise.resolve(JSON.stringify({ error: "no pairing token" })),
  } as unknown as Response;
}

function okResponse(body: Record<string, unknown>): Response {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: new Headers({ "content-type": "application/json" }),
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

function serverError(status = 500): Response {
  return {
    ok: false,
    status,
    statusText: `HTTP ${status}`,
    headers: new Headers(),
    json: () => Promise.resolve({ error: "boom" }),
    text: () => Promise.resolve(JSON.stringify({ error: "boom" })),
  } as unknown as Response;
}

function singleSeed(fetchFn: typeof fetch): SeedClient {
  return new SeedClient({
    endpoints: "https://seed.test:8443",
    auth: { pairingToken: "tok-test" },
    tls: { insecure: true },
    retries: 0,
    fetch: fetchFn,
  });
}

function meshSeed(fetchFn: typeof fetch): SeedClient {
  return new SeedClient({
    endpoints: ["https://peer-a:8443", "https://peer-b:8443"],
    auth: { pairingToken: "tok-test" },
    tls: { insecure: true },
    retries: 0,
    fetch: fetchFn,
  });
}

describe("trust-score protection (issue #16)", () => {
  it("aborts on the 3rd consecutive AuthError with TrustScoreBlockedError", async () => {
    const fetchFn = vi.fn().mockResolvedValue(authResponse(401));
    const c = singleSeed(fetchFn as unknown as typeof fetch);

    // Calls 1 and 2 surface AuthError as usual.
    await expect(c.status()).rejects.toBeInstanceOf(AuthError);
    await expect(c.status()).rejects.toBeInstanceOf(AuthError);

    // The 3rd call must throw TrustScoreBlockedError and must NOT
    // dispatch another HTTP request (would burn the seed's budget).
    const before = fetchFn.mock.calls.length;
    await expect(c.status()).rejects.toBeInstanceOf(TrustScoreBlockedError);
    const after = fetchFn.mock.calls.length;

    // We allow the third increment to come from an in-flight request or
    // from the pre-dispatch gate — either way, call #4 must NOT happen.
    expect(after - before).toBeLessThanOrEqual(1);

    // A 4th attempt should still trip the gate without dispatching.
    const gated = fetchFn.mock.calls.length;
    await expect(c.status()).rejects.toBeInstanceOf(TrustScoreBlockedError);
    expect(fetchFn.mock.calls.length).toBe(gated);
  });

  it("TrustScoreBlockedError carries peerKey, consecutiveFailures=3, retryableAfter=null", async () => {
    const fetchFn = vi.fn().mockResolvedValue(authResponse(403));
    const c = singleSeed(fetchFn as unknown as typeof fetch);

    await c.status().catch(() => void 0);
    await c.status().catch(() => void 0);
    try {
      await c.status();
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(TrustScoreBlockedError);
      const e = err as TrustScoreBlockedError;
      expect(e.peerKey).toBe("https://seed.test:8443");
      expect(e.consecutiveFailures).toBe(3);
      expect(e.retryableAfter).toBeNull();
      expect(e.code).toBe("TRUST_SCORE_BLOCKED");
    }
  });

  it("a 2xx success resets the counter (401, 401, 200, 401 is only 1 fail since reset)", async () => {
    const fetchFn = vi
      .fn()
      // call 1: 401
      .mockResolvedValueOnce(authResponse(401))
      // call 2: 401
      .mockResolvedValueOnce(authResponse(401))
      // call 3: 200 — resets the streak
      .mockResolvedValueOnce(okResponse({ total_vectors: 0, paired: true }))
      // call 4: 401 — counter is now 1 (NOT 3)
      .mockResolvedValueOnce(authResponse(401));

    const c = singleSeed(fetchFn as unknown as typeof fetch);

    await expect(c.status()).rejects.toBeInstanceOf(AuthError);
    await expect(c.status()).rejects.toBeInstanceOf(AuthError);
    // Success — counter cleared.
    await expect(c.status()).resolves.toBeDefined();
    // Post-reset auth failure is NOT a block.
    await expect(c.status()).rejects.toBeInstanceOf(AuthError);

    // Internal counter should be 1 (not 3), so one more auth fail is
    // still allowed without triggering the block.
    expect(c.trustScoreFailures("https://seed.test:8443")).toBe(1);
  });

  it("counters are independent per peer (401 on A does not block B)", async () => {
    // The mesh client has two peers. Pin each request through a session
    // so we can prove the counter is peer-scoped.
    const fetchFn = vi.fn().mockResolvedValue(authResponse(401));
    const c = meshSeed(fetchFn as unknown as typeof fetch);

    const sessionA = new (await import("../../../src/seed/session.js")).SeedSession(
      c,
      "https://peer-a:8443",
    );
    const sessionB = new (await import("../../../src/seed/session.js")).SeedSession(
      c,
      "https://peer-b:8443",
    );

    // Two 401s against peer-A.
    await expect(sessionA.status()).rejects.toBeInstanceOf(AuthError);
    await expect(sessionA.status()).rejects.toBeInstanceOf(AuthError);

    // A single 401 against peer-B must NOT trigger the block on B even
    // though A is already at 2 strikes.
    await expect(sessionB.status()).rejects.toBeInstanceOf(AuthError);

    expect(c.trustScoreFailures("https://peer-a:8443")).toBe(2);
    expect(c.trustScoreFailures("https://peer-b:8443")).toBe(1);

    // Third strike on A fires the block; B remains at 1 strike.
    await expect(sessionA.status()).rejects.toBeInstanceOf(TrustScoreBlockedError);
    await expect(sessionB.status()).rejects.toBeInstanceOf(AuthError);
    expect(c.trustScoreFailures("https://peer-b:8443")).toBe(2);
  });

  it("TrustScoreBlockedError is NOT retryable — failover does not cycle to next peer", async () => {
    // Two peers, both answer 401. If the failover cycled on AuthError,
    // peer-B would get hit after peer-A's 3rd strike. It must NOT.
    const fetchFn = vi.fn().mockResolvedValue(authResponse(401));
    const c = meshSeed(fetchFn as unknown as typeof fetch);

    // Drive peer-A to 3 strikes via the pinned session.
    const { SeedSession } = await import("../../../src/seed/session.js");
    const sessionA = new SeedSession(c, "https://peer-a:8443");

    await sessionA.status().catch(() => void 0);
    await sessionA.status().catch(() => void 0);

    const callsBefore = fetchFn.mock.calls.length;
    await expect(sessionA.status()).rejects.toBeInstanceOf(TrustScoreBlockedError);
    const callsAfter = fetchFn.mock.calls.length;

    // At most 1 new call (the 3rd 401 that tripped the gate). The
    // failover state machine MUST NOT have cycled to peer-B.
    expect(callsAfter - callsBefore).toBeLessThanOrEqual(1);

    // Verify none of the fetch calls targeted peer-B.
    for (const call of fetchFn.mock.calls) {
      const url = String(call[0]);
      expect(url).not.toContain("peer-b");
    }
  });

  it("cycling on 5xx still works after a prior 401 (auth doesn't poison non-auth)", async () => {
    // Peer-A: 401 (counts), then 500 (must still cycle to peer-B).
    // Peer-B: 200 (success).
    const responses = [
      authResponse(401),
      serverError(500),
      okResponse({ total_vectors: 0, paired: true }),
    ];
    let i = 0;
    const fetchFn = vi.fn().mockImplementation(() => {
      const r = responses[Math.min(i, responses.length - 1)];
      i += 1;
      return Promise.resolve(r);
    });

    const c = meshSeed(fetchFn as unknown as typeof fetch);

    // First call: 401 on peer-A (the closest-first pick).
    await expect(c.status()).rejects.toBeInstanceOf(AuthError);
    expect(c.trustScoreFailures("https://peer-a:8443")).toBe(1);

    // Second call: 500 on peer-A must cycle to peer-B → 200 succeeds.
    // The 5xx is NOT an AuthError so it must NOT increment the counter.
    const result = await c.status();
    expect(result).toBeDefined();
    // Still 1 strike from the earlier 401 — 5xx did not count.
    expect(c.trustScoreFailures("https://peer-a:8443")).toBeLessThanOrEqual(1);
    // Peer-B served the response successfully, so its counter is 0.
    expect(c.trustScoreFailures("https://peer-b:8443")).toBe(0);
  });

  it("resetTrustScore(peerKey) clears one peer's counter", async () => {
    const fetchFn = vi.fn().mockResolvedValue(authResponse(401));
    const c = singleSeed(fetchFn as unknown as typeof fetch);

    await c.status().catch(() => void 0);
    await c.status().catch(() => void 0);
    expect(c.trustScoreFailures("https://seed.test:8443")).toBe(2);

    c.resetTrustScore("https://seed.test:8443");
    expect(c.trustScoreFailures("https://seed.test:8443")).toBe(0);

    // Next 401 is counted from zero.
    await expect(c.status()).rejects.toBeInstanceOf(AuthError);
    expect(c.trustScoreFailures("https://seed.test:8443")).toBe(1);
  });

  it("resetTrustScore() with no argument clears every peer", async () => {
    const fetchFn = vi.fn().mockResolvedValue(authResponse(401));
    const c = meshSeed(fetchFn as unknown as typeof fetch);
    const { SeedSession } = await import("../../../src/seed/session.js");

    await new SeedSession(c, "https://peer-a:8443").status().catch(() => void 0);
    await new SeedSession(c, "https://peer-b:8443").status().catch(() => void 0);
    expect(c.trustScoreFailures("https://peer-a:8443")).toBe(1);
    expect(c.trustScoreFailures("https://peer-b:8443")).toBe(1);

    c.resetTrustScore();
    expect(c.trustScoreFailures("https://peer-a:8443")).toBe(0);
    expect(c.trustScoreFailures("https://peer-b:8443")).toBe(0);
  });

  // ---- concurrency race (security audit H2) --------------------------
  //
  // JavaScript is single-threaded, but async-concurrent. The bug: all
  // in-flight callers pass the pre-dispatch `counter < 3` gate BEFORE
  // any of them gets a 401 back. So firing 10 concurrent status() calls
  // with a 401-returning server sends 10 requests on the wire — the
  // counter only starts climbing after responses arrive. Goal: never
  // exceed the seed's 3-strike budget regardless of how many concurrent
  // callers fire against the same peer.

  it("caps concurrent in-flight 401s at 3 (audit H2)", async () => {
    // Block the fetch until we say "go" so we can fire N concurrent
    // requests that are ALL in the "waiting for response" state at the
    // same time — mirroring the race the audit flagged.
    let resolveGate: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      resolveGate = resolve;
    });
    let dispatched = 0;
    const fetchFn = vi.fn(async () => {
      dispatched += 1;
      await gate; // hold until we release
      return authResponse(401);
    });

    const c = singleSeed(fetchFn as unknown as typeof fetch);

    // Fire 10 concurrent requests. All of them should pass the
    // pre-dispatch gate under the old code (counter=0). Under the fix,
    // only the first 3 make it to the wire; the rest fail fast with
    // TrustScoreBlockedError without ever calling fetch. We attach a
    // dummy `.catch` on each so vitest's unhandled-rejection detector
    // doesn't flag the blocked promises before `allSettled` collects
    // them — the rejections are expected and deliberate.
    const inflight = Array.from({ length: 10 }, () => {
      const p = c.status();
      p.catch(() => undefined);
      return p;
    });

    // Let event-loop settle so all 10 have had a chance to either
    // dispatch or be blocked.
    await new Promise((resolve) => setTimeout(resolve, 20));

    // At most 3 should have hit the wire.
    expect(dispatched).toBeLessThanOrEqual(3);

    // Release the gate so the in-flight ones can complete (they'll get
    // 401 and either AuthError or TrustScoreBlockedError).
    resolveGate?.();

    const outcomes = await Promise.allSettled(inflight);

    // Count how many were AuthError vs TrustScoreBlockedError. At most
    // 3 should be AuthError (the ones that hit the wire); the rest must
    // be TrustScoreBlockedError (blocked at the gate).
    const authErrors = outcomes.filter(
      (o) =>
        o.status === "rejected" && o.reason instanceof AuthError,
    ).length;
    const blocked = outcomes.filter(
      (o) =>
        o.status === "rejected" &&
        o.reason instanceof TrustScoreBlockedError,
    ).length;

    expect(authErrors).toBeLessThanOrEqual(3);
    expect(blocked).toBeGreaterThanOrEqual(7);
    expect(authErrors + blocked).toBe(10);

    // The counter should be exactly 3 — the in-flight requests that
    // actually received 401s, not poisoned by the blocked ones.
    expect(c.trustScoreFailures("https://seed.test:8443")).toBe(3);
  });

  it("in-flight 2xx releases the reservation so later 401s count normally", async () => {
    // Fire 2 concurrent requests. First returns 200, second returns 401.
    // The 2xx must release its reservation (and clear the counter), so a
    // later 401 starts from zero — the in-flight bookkeeping must not
    // leak a permanent "1 strike" from the successful request.
    const responses: Array<Response> = [okResponse({ ok: true }), authResponse(401)];
    const fetchFn = vi.fn(async () => {
      const r = responses.shift();
      if (r === undefined) throw new Error("unexpected extra dispatch");
      return r;
    });

    const c = singleSeed(fetchFn as unknown as typeof fetch);
    const [a, b] = await Promise.allSettled([c.status(), c.status()]);

    // One succeeded, one failed with AuthError.
    expect(a.status === "fulfilled" || b.status === "fulfilled").toBe(true);
    // Counter is 1 (one AuthError), not 0 (not poisoned by the 2xx) and
    // not higher (in-flight didn't leak).
    expect(c.trustScoreFailures("https://seed.test:8443")).toBe(1);
  });

  // Silence an unused-import warning from verbose linters — we import
  // ServiceUnavailableError to document the 5xx path in the scenarios
  // above even though we match by status rather than instance in the
  // helpers themselves.
  void ServiceUnavailableError;
});
