# Cognitum SDK Security Audit — v0.2.0

**Scope**: `sdks/{node,python,rust}` — contract divergence audit.
**Date**: 2026-04-23.
**Method**: Read-through of TLS pinning, token handling, trust-score counters, retry, discovery, error taxonomy across all three SDKs, with a focus on places the three diverge.
**Ignored**: The 75-finding regex SAST (false positives as stated).

Findings are ordered by severity. File:line references are against HEAD (post-0.2.0).

---

## CRITICAL

### C1. Node fingerprint pin uses `startsWith` → prefix-match forgery trivial
**File**: `sdks/node/src/seed/transport.ts:261-271`

```ts
function matchFingerprint(expected: string, actual: string | undefined): boolean {
  if (!actual) return false;
  if (expected.length === 0) return false;
  if (expected.length > actual.length) return false;
  return actual.startsWith(expected);   // ← prefix match, no floor
}
```

`buildPinnedAgent` pairs this with `rejectUnauthorized: false` (line 203) — the fingerprint IS the entire trust anchor. There is no minimum length enforced on `expected`. Combined with `parseFingerprint` in `discovery/mdns.ts:265-284`, which accepts any even-length hex string ≥ 2 chars, an attacker who controls the mDNS response can advertise a single-byte `fp=ab` and match 1/256 of all possible self-signed certs — forgery takes seconds on a dev box. A `fp=` of 4 hex chars (2 bytes) matches 1/65_536, still easily brute-forced offline.

The in-module comment *"the seed truncates to 16 hex chars — 8 bytes — per its TXT budget"* (line 180) documents the intent but is not enforced. The Rust SDK by contrast enforces exactly 64 hex chars via `parse_hex_sha256` (`tls_pin.rs:240-251`); the Python SDK enforces 64 hex chars in `_parse_fp_txt` (`discovery/mdns.py:61`). Node is the odd one out.

**Attack scenario**: attacker on the same LAN as the SDK emits a crafted `_cognitum._tcp.local` PTR/TXT response with `fp=00` (2 chars, passes `parseFingerprint`). Generates self-signed certs in a tight loop until SHA-256 prefix matches `00`. Within seconds, presents a MITM cert that the SDK accepts because `actual.startsWith("00") === true`. Pairing token is then delivered to the attacker on `POST /api/v1/pair`.

**Fix**: in `matchFingerprint`, require `expected.length === 64` (full SHA-256 hex). In `parseFingerprint`, reject unless `s.length === 64`. Match Rust / Python strictness. If the seed really does truncate in the TXT record, change the seed — truncated pins are broken by design. Add a regression test asserting `matchFingerprint("ab", "ab…")` returns `false`.

**Severity**: CRITICAL. This is the entire trust anchor when talking to a self-signed seed.

---

### C2. Python TLS pin verification races the first request
**File**: `sdks/python/cognitum/seed/_transport.py:272-348` + `_client.py:300-303`

`PinVerifier.verify()` is called **before** the httpx dispatch:

```python
# _client.py line 300-302
if self._pin_verifier.needs_verification(peer.endpoint.url):
    self._pin_verifier.verify(peer.endpoint.url)
```

`verify()` opens a *separate* TLS socket via `ssl.get_server_certificate()`, hashes the returned cert, compares. Then the actual request is dispatched through httpx with a **different** TLS handshake over a **different** connection. An attacker who can answer handshake #1 with the genuine cert (replaying a captured handshake fragment, or simply being the real seed for a moment) and then handshake #2 with a forged cert bypasses the pin entirely. This is a textbook TOCTOU — the thing you verified is not the thing you then use.

Both the Rust (`FingerprintPinVerifier::verify_server_cert`) and Node (per-peer `Agent` with `checkServerIdentity`) implementations verify the pin **on the actual connection being used for the request**. Python is alone in verifying out-of-band.

Compounding: the pin is cached after the first success (`_verified` set, line 347-348). Every subsequent call reuses the cache with no re-verification. If an attacker wins the race exactly once, every subsequent request on the client's lifetime dispatches against whatever cert the attacker serves — the cache does not re-check.

**Attack scenario**: network attacker holds the genuine cert briefly (or proxies the real seed for the initial handshake), then hijacks the next connection. `_verified` contains the peer URL; `verify` returns immediately; httpx handshakes against the attacker who presents a forged cert; because `SeedPinnedVerifier.to_ssl_context()` falls back to `CERT_NONE` when neither CA nor pin is used for httpx verification (line 123-125), chain validation is off. Token leaks.

**Fix**: implement the pin as an httpx Transport (or custom `ssl.SSLContext` with `get_verified_chain` post-handshake verification) so the verified cert and the dispatched cert are the same object. As a stopgap, bake the pinned fingerprint into an `SSLContext` via a verify-callback that runs on every handshake rather than a separate probe. The comment in `_transport.py:282-287` acknowledges the design trade-off but understates it: "one extra TLS handshake per peer at first use" is not the only cost — correctness is broken.

**Severity**: CRITICAL. The existing pin verifier gives a false sense of security; callers believe mDNS-spoof-resistant pinning is active when it isn't.

---

### C3. Python insecure flag flips `check_hostname` + `CERT_NONE` globally on the client's SSL context
**File**: `sdks/python/cognitum/seed/_transport.py:102-107` + `:123-125`

When `tls.insecure=True`, `to_ssl_context()` builds a fresh context with `verify_mode = CERT_NONE` (line 106). That's fine in isolation — but `build_verify` also returns `False` (line 145) which disables verification in httpx for this client. The key concern: `_fetch_peer_cert_sha256` at `:254-269` opens a raw socket with `ssl.get_server_certificate((host, port), timeout=timeout)`. `get_server_certificate` has NO argument for SNI or hostname verification — it always uses `CERT_NONE` semantics internally. If the pin verifier call path is gated behind `needs_verification` but the cache says "already verified" (C2), the raw socket call *only happens once ever* per peer URL, even when the caller rotates between insecure + pinned modes. No bypass of TLS scoping per se, but the interaction compounds C2.

Additionally, the default-host fallback path (`_is_default_host`, line 30-46, `_DEFAULT_SEED_HOSTS = {"169.254.42.1", "cognitum.local"}` plus any `169.254.*` / `fe80:*`) STILL does `check_hostname = False; verify_mode = CERT_NONE` even in 0.2.0 after the localhost fix. A caller who reaches `cognitum.local` (the default mDNS name) with no `tls=` argument silently bypasses all TLS verification, warning once via `_warn_default_host_insecure`. The warning uses `warnings.warn` with `stacklevel=3` — this is easily missed in a noisy log, and the silent bypass stays active for the process lifetime. In a production scenario where someone's DNS returns `cognitum.local` (malicious or misconfigured), an attacker gets MITM for free.

**Fix**: the warning must fail-closed, not fail-open. Either require `tls=SeedTLS(insecure=True)` as an explicit opt-in even on default hosts, or require `tls=SeedTLS(pinned_sha256=b"...")` — any path that produces `CERT_NONE` should require an explicit caller flag. Remove the silent fallback; surface a `ConfigError` with the same message. The Node + Rust equivalents do not have this silent-fallback code path.

**Severity**: CRITICAL (regression surface). A Python caller who does not pass `tls=` and lands on a default host gets no TLS verification at all.

---

## HIGH

### H1. Rust `SecretString` Serde round-trip silently emits raw token
**File**: `sdks/rust/src/seed/token_book.rs:78-104`

```rust
impl Serialize for SecretString {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.inner)   // ← raw token
    }
}
```

The Debug impl redacts, but `serde_json::to_string(&secret)` emits the token verbatim. Node's `SecretString.toJSON()` returns `"<redacted>"` and will round-trip through JSON as `"<redacted>"`. Python's `SecretString.__repr__` redacts but the class has no custom JSON behavior — `json.dumps(secret.as_str())` is explicit.

The Rust divergence is dangerous because:
1. `PairCreateResponse` embeds `SecretString` as its `token` field (referenced by doc comment). A caller who logs or persists `serde_json::to_string(&response)?` for diagnostics gets the raw token on disk.
2. The doc comment on the `Serialize` impl explicitly justifies this: *"so wire-type response structs that embed `SecretString` … can round-trip through JSON"*. This is the exact opposite of what the Node/Python impls do for the wrapper — they redact at serialize time. If the token needs to round-trip through the wire, that should be a separate wrapper type, not the one whose whole purpose is redaction.
3. `Default` for `SecretString` returns empty-inner. Good.
4. `Clone` copies the inner string. Dropping the clone will also zero-fill via `Drop`, but briefly there are two copies in memory.

**Attack scenario**: caller uses `tracing::info!(response = ?pair_response)` — that's redacted (Debug). Next sprint, caller switches to `tracing::info!(response = %serde_json::to_string(&pair_response)?)` to get structured logs. Token now in logs. Grep for `serialize_str(&self.inner)` is the load-bearing line.

**Fix**: change `Serialize` to emit `"<redacted>"` (like Node). Provide a separate `RawToken(String)` newtype (no Debug, no Serialize) that callers explicitly opt into via `SecretString::into_raw()` when the wire path genuinely needs the value — mirror Node's `.reveal()`. Re-check `Deserialize` is OK (it is — it accepts a string and wraps).

**Severity**: HIGH. Silent leak surface; one careless `to_string` leaks the token.

---

### H2. Node trust-score counter is a plain `Map` → race under concurrent requests
**File**: `sdks/node/src/seed/client.ts:169` + `:590-595`

```ts
private readonly authFailures: Map<string, number> = new Map();
// ...
if (outcome.error instanceof AuthError) {
  const next = (this.authFailures.get(peer.key) ?? 0) + 1;
  this.authFailures.set(peer.key, next);   // ← non-atomic
  if (next >= SeedClient.TRUST_SCORE_LIMIT) {
    throw new TrustScoreBlockedError(peer.key);
  }
}
```

JavaScript is single-threaded, but the `SeedClient` is concurrency-capable — multiple in-flight `request()` calls interleave their `await` points. Between `this.authFailures.get(peer.key)` and `.set(peer.key, next)`, another awaiting `request()` may have already read+written the same key. Two concurrent 401s both observe "counter is 2" and both write "counter is 3" instead of 3 and 4 — the third request that should have been short-circuited is dispatched, which burns the seed's own 3-strike budget (the exact thing this logic was added to prevent, per the block comment at line 169-168).

Python uses `threading.Lock` (`_client.py:208-211`); Rust uses `Mutex<BTreeMap<…>>` (`client.rs:678-687`). Node has nothing because the author assumed single-threaded-means-safe. That assumption breaks under concurrency.

**Attack scenario**: user of the SDK fires 3 parallel requests (e.g. `Promise.all([client.store.query(...), client.store.query(...), client.store.query(...)])` against the same peer with a revoked token. All three get 401. The increment race means counter never hits 3 before the third request is already out on the wire. Seed sees 3 auth failures, locks the IP for 5 minutes. The whole SDK instance is now blocked from ever reaching the peer, even after the caller rotates the token.

**Fix**: the counter read-increment needs to be atomic with the "should I block?" check. Either serialise all auth-failure writes through a single awaited queue, or — simpler — rewrite the handler as:

```ts
const key = peer.key;
const next = (this.authFailures.get(key) ?? 0) + 1;
this.authFailures.set(key, next);
if (next >= SeedClient.TRUST_SCORE_LIMIT) throw new TrustScoreBlockedError(key);
// Also: check the gate at dispatch (the code at line 556-560 already does
// this) — but the gate also reads without a lock, so two concurrent
// dispatches that both see count=2 both pass the gate. Re-check at the
// gate + at the post-outcome handler is still racy. The only correct
// fix is an atomic "incrementAndCheck" that returns the post-increment
// value inside one synchronous block (no await between read and write).
```

Since JS Maps + await yield turns between them, wrap the counter ops in a helper that does not `await` mid-op (the code above already does — it's synchronous). The race is specifically between two different `request()` invocations that both reach their own `get/set` pair. The synchronous nature of the get/set inside a single invocation is not the issue; cross-invocation ordering is. The cleanest fix: keep the `Map` but check the gate INSIDE the dispatchOnce catch path using the post-increment value, and use `AsyncLocalStorage`-free serialization — or simpler: every auth-failure increment also immediately re-checks the gate. Today, lines 590-596 do this. Two concurrent invocations hitting 401 at the same time both see `next = previous + 1`. If previous was 2, both compute `next = 3` → both throw TrustScoreBlockedError (correct). If previous was 1, both compute `next = 2` → neither blocks, then both dispatch request #3 which gives 401, now counter is 3 → but request #3 already went out = burned the budget.

Minimum fix: at the top of each iteration, in addition to `this.authFailures.get(peer.key) ?? 0`, assume the worst-case concurrent tally. Or (the proper fix) keep a `Map<peerKey, Promise<void>>` of in-flight auth-bearing requests and serialise them per-peer so only one can be burning the budget at a time.

**Severity**: HIGH. Symptom is a 5-minute seed lockout that the documented defence was supposed to prevent.

---

### H3. Node per-peer dispatcher bypasses tls.insecure scope; OK, but `rejectUnauthorized: false` is baked in for any peer with a fingerprint
**File**: `sdks/node/src/seed/transport.ts:195-210`

```ts
return new Agent({
  // ...
  connect: {
    rejectUnauthorized: false,   // always off for pinned peers
    checkServerIdentity: makePinCheckServerIdentity(peerKey, expectedFingerprint),
  },
});
```

This is correct *when the fingerprint is strong* (C1) — the pin is the trust anchor. But because C1 allows a 2-char fingerprint, `rejectUnauthorized: false` + a weak pin means any self-signed cert whose SHA-256 starts with the prefix is accepted; standard chain validation that would have caught a plainly-wrong-issuer cert is off. Closing C1 reduces this finding to "intentional". Without C1 closed, the two bugs compose.

**Severity**: HIGH (compounds C1; fix C1 first).

---

### H4. Tailscale prefix filter is a substring-equivalent — `cognitum-` matches `cognitum-evil.attacker.com` if attacker sets their tailnet hostname
**File**: `sdks/node/src/seed/discovery/tailscale.ts:157-159`, `sdks/python/cognitum/seed/discovery/tailscale.py:248-257`, Rust equivalent in `seed/discovery/tailscale.rs` (not read, but parallel structure).

```ts
// Node
const candidate = (p.HostName ?? p.DNSName ?? "").toLowerCase();
return candidate.startsWith(this.prefix);   // prefix="cognitum-"
```

```python
# Python
candidate = peer.get("HostName") or peer.get("DNSName") or ""
return candidate.lower().startswith(self._prefix)
```

Any tailnet member whose hostname begins with `cognitum-` is accepted as a seed. On a shared tailnet (the main Tailscale use case), an attacker who can join the tailnet under any hostname they choose (their own laptop) names it `cognitum-fake` and gets selected. The SDK then tries to pair against the attacker's machine, delivering its pairing token on `POST /api/v1/pair`.

The spec says *"`cognitum-*` prefix match is exact (not substring)"*. The code is "starts with the prefix" — not exact. An exact match would require equality to a known-good hostname. Prefix matching is inherently insecure against hostnames an attacker controls.

Compounding: on the tailnet there's no mDNS `fp=` — the Tailscale provider sets `tls_fingerprint = None`. So pinning is off by default for Tailscale-discovered peers. `tls.ca` must be supplied; if not, `tls.insecure` is the only way to talk to a self-signed seed — and that turns off verification entirely.

**Attack scenario**: victim runs the SDK with `TailscaleDiscovery()` on a shared corp tailnet. Attacker is any other tailnet member; names their host `cognitum-lol`; the SDK picks it, pairs against it, pairing token exfiltrates. Worst case on an enterprise tailnet: every SDK user is paired to the attacker.

**Fix**: TailscaleDiscovery must require either (a) an explicit allowlist of trusted tailnet hostnames, (b) a cryptographic assertion delivered via a side channel (Tailscale ACL tags, for example — Tailscale supports `tag:cognitum-seed`), or (c) be paired with an mDNS-style `fp=` assertion discovered another way. The `prefix` parameter is fine as a coarse filter; it MUST NOT be the only trust gate. Document this loudly.

**Severity**: HIGH. Enterprise-tailnet use case; easy to trigger; no TLS pin available.

---

### H5. Rust `SecretString::Drop` uses `unsafe { as_bytes_mut }` — sound but the compiler can trivially optimise the zero-fill out
**File**: `sdks/rust/src/seed/token_book.rs:106-116`

```rust
impl Drop for SecretString {
    fn drop(&mut self) {
        let bytes = unsafe { self.inner.as_bytes_mut() };
        for b in bytes {
            *b = 0;
        }
    }
}
```

LLVM's dead-store elimination can (and at `-O2` routinely does) delete writes to memory that's about to be freed. The comment at line 108-110 acknowledges this: *"Not a hard guarantee against compiler optimisation"*. In Rust, the canonical fix is `core::ptr::write_volatile` per-byte or the `zeroize` crate — `zeroize` uses `core::sync::atomic::compiler_fence(SeqCst)` to prevent the optimiser from eliding the writes. Without it, the Drop impl is cosmetic on release builds. This doesn't make the bug itself CRITICAL — the token is already cleared from the owning `Map` — but the claim that it's zeroed on drop is not true.

**Fix**: depend on `zeroize` or use `ptr::write_volatile` explicitly. Update the docstring to reflect what actually happens, or implement the real thing.

**Severity**: HIGH (integrity of a security claim).

---

## MEDIUM

### M1. Env var precedence: Rust never reads `COGNITUM_SEED_TOKEN`; Node does; Python doesn't
**Files**:
- Node: `sdks/node/src/seed/config.ts:243-248` — reads `process.env.COGNITUM_SEED_TOKEN` as a fallback when `auth.pairingToken` is unset.
- Python: `sdks/python/cognitum/seed/_config.py` — no env var read anywhere in the config resolver.
- Rust: `sdks/rust/src/seed/config.rs` — no env var read.

Contract mismatch. The spec expected: *"explicit arg → COGNITUM_SEED_TOKEN env → error. No other env vars silently consulted."* Node implements (1) and (2). Python and Rust only implement (1). Beyond the contract drift, the Node-only behaviour creates a supply-chain surface: a malicious dependency can set `process.env.COGNITUM_SEED_TOKEN` and the SDK will silently use that token. No other env vars are consulted (searching the tree confirms only `COGNITUM_SUPPRESS_BEARER_WARNING` and `COGNITUM_SEED_TOKEN` are read in source), so the Node behaviour is at least narrowly scoped.

If the env var fallback is intentional, all three SDKs should implement it, and the behaviour should be opt-in (`SeedClient.fromEnv()` factory) rather than silent resolution inside the config builder. If it's not intentional, remove from Node.

**Severity**: MEDIUM (integrity + contract drift).

---

### M2. Python `tailscale.py` runner accepts caller-controlled `command` with no argv validation
**File**: `sdks/python/cognitum/seed/discovery/tailscale.py:108-132`

```python
def __init__(self, *, command: str | Sequence[str] = _DEFAULT_COMMAND, ...) -> None:
    # ...
    self._command: list[str] = (
        [command] if isinstance(command, str) else list(command)
    )
```

The `command` is passed to `subprocess.run(argv, ...)` with `shell=False` (line 172), so shell-injection is not a concern. However, a caller can pass `command=["bash", "-c", "curl attacker.com"]` — intended or not, this bypasses the "tailscale" expectation. The spec asks us to confirm there's no shell injection if `hostname` is adversarial — confirmed; `hostname` does not feed into `argv`. The broader concern is that `command` is caller-controlled with no validation; that's a policy choice (the CLI path may need to be absolute on some systems). Document and possibly add a warning if `argv[0]` is not literally `tailscale` / `tailscale.exe`.

**Severity**: MEDIUM → LOW. Caller-intent, not attacker-reachable unless they can already inject into your code.

---

### M3. Python `_parse_fp_txt` accepts colons-anywhere — ambiguity with truncated multi-fp lists
**File**: `sdks/python/cognitum/seed/discovery/mdns.py:44-67`

```python
low = low.replace(":", "").replace(" ", "")
```

Strip-all-colons means `fp=sha256:aa:bb:cc:…` (66 chars after prefix strip) normalises to `aabbcc…` (64 chars) — fine. But it also means `fp=aa:bb` with a trailing colon parses as `aabb` (4 chars), which fails length 64 and rejects. OK. But `fp=sha256:aabb:cc…dd:ee` with a trailing ":ee" (66 chars) could normalise incorrectly. Testing this edge case is not covered by unit tests visible in the tree. The Node parser has the same `replace(/:/g, "")` behaviour but enforces `length % 2 === 0` + length ≤ 64 (it's `% 2` — but see C1 on length). Rust enforces exactly 64. All three end up in roughly the same place.

A corner-case: **duplicate `fp=` TXT entries**. The spec asks about this — what happens with duplicates? In Python (line 207-215, `_decode_txt`), the TXT dict keyed by string overwrites on collision, so the last `fp=` wins silently. Same in Node `parseTxtRecord` (line 315, `out[key] = val`). An attacker who injects a second `fp=` in the TXT record (possible with crafted mDNS packets — `multicast-dns` in the Node implementation doesn't de-duplicate) overrides the real pin with their own. Whether an attacker can inject extra TXT entries depends on the mDNS responder — generally they can on a shared LAN. The defence should reject the record outright when it has two `fp=` entries. Today, neither SDK does.

**Fix**: in `_decode_txt` (Python) and `parseTxtRecord` (Node), collect values into a list and error on any key with `> 1` entry. Attacker injecting a duplicate now gets a rejection, not a silent override.

**Severity**: MEDIUM.

---

### M4. Python `_client.py` 429 path cycles peers via mark_failure bookkeeping
**File**: `sdks/python/cognitum/seed/_client.py:393-410`

```python
if status == 503:
    self._mark_failure(peer.endpoint.url, PeerErrorClass.SERVICE_UNAVAILABLE)
elif status in (500, 502, 504):
    self._mark_failure(peer.endpoint.url, PeerErrorClass.SERVER_5XX)

# Dispatch per §D3.
if status in _CYCLE_STATUS:
    peers_tried += 1
    # ... try next peer
elif status == 429:
    # Pin on same peer; do NOT cycle.
    pass
```

429 path does NOT call `mark_failure`, so the 60-second wall-clock ceiling + 3-strike bookkeeping in `PeerSet` does not progress on 429. This is correct per the intent (429 means "you are being rate-limited, not that the peer is dead"). But this also means under sustained 429 against a single peer, the mesh failover state machine never cycles — the retry loop keeps hitting the same peer forever, bounded only by `max_retries` (default 3) and the 60s deadline. Not a security finding per se; surfaces as a DoS of the client.

The 60s ceiling is enforced per-peer-cycle via `deadline = time.monotonic() + max_elapsed_ms / 1000.0` set ONCE at the top of `request()` (line 277-279). Confirmed: the 60s is a wall-clock total across ALL peer attempts combined, not per-peer. Good. Node enforces the same at `client.ts:498,540`. Rust enforces at `client.rs:481-486`. All three match. No finding.

---

### M5. Equal-jitter modulo bias — Rust fixed, Python has a latent issue
**File**: `sdks/python/cognitum/seed/_retry.py:120-133`

```python
raw = min(policy.cap_ms, policy.base_ms * (2**attempt))
jitter = r.uniform(0, policy.base_ms)   # floats → no modulo
```

Python uses `random.uniform` which draws floats; there is no modulo to be biased. Good. Node (`retry.ts:80-82`) uses `Math.random() * BASE_MS` — also float-based, no bias. Rust (`retry.rs:77-95`) uses rejection sampling from xorshift64 explicitly to avoid modulo bias — the tests at line 294-319 document the concern and assert the fix. All three are fine. The prior `subsec_nanos % base` issue called out in the Rust tests is already closed.

No finding.

---

### M6. Retry on POST + `idempotent: true` — Node only retries connect-phase timeouts
**File**: `sdks/node/src/seed/client.ts:693-702`

```ts
if (err instanceof TimeoutError) {
  if (err.phase === "connect") return true;
  if (method === "POST" && !idempotent) return false;
  return true;
}
```

Correct. The Python equivalent at `_retry.py:52-56`:

```python
if is_timeout:
    if timeout_phase == "connect":
        return True
    return not body_sent or method.upper() in _IDEMPOTENT_METHODS
```

Python auto-retries timeouts on any *method in the idempotent list* — which includes DELETE and PUT. The idempotency of DELETE is server-specific; PUT is idempotent per RFC, but the seed's `DELETE /api/v1/pair/{client_name}` is idempotent by spec (second DELETE is a 404, not a destructive redo). This matches the spec. But Node and Python disagree: Node only checks `idempotent: true` (caller attestation), whereas Python assumes all methods in `_IDEMPOTENT_METHODS` are idempotent by method type. In practice this matches the SDK's usage — no resource sends DELETE/PUT with `idempotent: false` — but if a future resource does, Python will happily retry it while Node will not.

**Severity**: MEDIUM (contract drift, not currently reachable).

---

## LOW

### L1. Node `TrustScoreBlockedError` is an `AuthError` subclass in Python, but a peer-of `AuthError` in Node
**Files**: `sdks/node/src/errors.ts:208-232` (direct subclass of `CognitumError`) vs. `sdks/python/cognitum/_errors.py:99-136` (subclass of `AuthError`).

A caller doing `except AuthError` in Python catches `TrustScoreBlockedError`; the same idiom in Node does not. This is a minor but real contract drift. The Rust taxonomy collapses both onto `Error::Auth(msg)` with a prefix marker, requiring string matching — worst-of-both-worlds but not a *security* finding.

**Severity**: LOW.

---

### L2. Python `insecure` + `verify` reconciliation is fragile
**File**: `sdks/python/cognitum/seed/_config.py:227-236`

```python
if tls_cfg.insecure and tls_cfg.verify:
    # insecure wins but we normalise to keep `verify` coherent.
    tls_cfg = SeedTLS(..., verify=False, insecure=True, ...)
```

Silent reconciliation. A caller who sets both `insecure=True` and `verify=True` expects to either get an error or get verification enabled. Getting `insecure=True` silently is the opposite of fail-closed. Either error out or honour `verify=True`.

**Severity**: LOW.

---

### L3. mDNS empty-fp and missing-fp behaviour
Per the spec: *"What happens with duplicate fp= entries? Missing fp=? Empty string?"*

- **Missing**: all three SDKs skip the peer's TLS-pin setup; fall through to `tls.ca` / `tls.insecure` policy. OK (documented).
- **Empty string**: Node `parseFingerprint` returns `undefined` (line 269); Python `_parse_fp_txt` returns `None` (line 53); Rust not directly tested but `build_pin_map` skips on `parse_hex_sha256` returning `None`. OK.
- **Duplicate**: M3.
- **Malformed (`fp=not-hex`)**: all three reject → no pin → fall through to base verifier. The fall-through is the concerning bit. If an attacker controls the mDNS response and sends a malformed `fp=` deliberately (e.g. `fp=xxxx`), the SDK proceeds WITHOUT pinning. On `tls.insecure=true` + `fp=malformed`, the attacker is now MITM'able. Arguably the SDK should treat "malformed fp= received" as a HARD error (someone is spoofing the record and trying to weaken the pin). Today it's a soft fall-through.

**Fix**: log a WARN on malformed `fp=` and consider fail-closed if the peer was discovered via mDNS (the very channel that promised the pin).

**Severity**: LOW.

---

### L4. Node TXT parsing — `key` lowercased, `value` not
**File**: `sdks/node/src/seed/discovery/mdns.ts:312-314`

```ts
const key = s.slice(0, idx).trim().toLowerCase();
const val = s.slice(idx + 1);
```

Case-insensitive key lookup is fine (matches Python's `_decode_txt`). Value preserved verbatim; `parseFingerprint` does its own `.toLowerCase()`. Fine.

---

### L5. Node `classifyPinFailure` walks cause chain with a `Set` cycle guard — good
**File**: `sdks/node/src/seed/transport.ts:285-315`. Cycle guard prevents infinite loops on self-referencing `cause`. Good.

---

### L6. Python `SecretString` has a `__hash__` that uses the raw value → could leak through a dict key
**File**: `sdks/python/cognitum/seed/_token_book.py:53-54`

```python
def __hash__(self) -> int:
    return hash(self._value)
```

A `SecretString` used as a dict key will hash on the raw value. Python's hash is randomised per-process (PYTHONHASHSEED), so the hash itself doesn't leak the token, but it does mean two `SecretString` objects with the same content collide — intentional for uniqueness, but slightly surprising. Not a leak surface.

**Severity**: LOW (observation, not a bug).

---

## SUMMARY TABLE

| # | Severity | Area | SDK | Fix complexity |
|---|----------|------|-----|----------------|
| C1 | CRITICAL | TLS fp pin (`startsWith`) | Node | Small (one line in `matchFingerprint` + `parseFingerprint`) |
| C2 | CRITICAL | TLS pin TOCTOU | Python | Medium (Transport subclass or SSLContext callback) |
| C3 | CRITICAL | Silent CERT_NONE on default host | Python | Small (remove silent fallback) |
| H1 | HIGH | `SecretString::Serialize` leaks raw | Rust | Small (change serialize impl) |
| H2 | HIGH | Trust-score counter race | Node | Medium (per-peer serialization) |
| H3 | HIGH | `rejectUnauthorized: false` + weak pin | Node | Closes with C1 |
| H4 | HIGH | Tailscale prefix match | All 3 | Medium (allowlist + ACL tag) |
| H5 | HIGH | Rust zeroize soundness | Rust | Small (`zeroize` crate) |
| M1 | MEDIUM | Env var contract drift | Node (+/-) | Small (policy call) |
| M2 | MEDIUM | argv validation | Python | Small |
| M3 | MEDIUM | Duplicate TXT `fp=` override | Node + Python | Small |
| M6 | MEDIUM | POST+timeout retry policy | Python | Small |
| L1-L6 | LOW | Contract/taxonomy nits | various | Various |

---

## TOP 3 TO FIX THIS WEEK

1. **C1 (Node startsWith fingerprint)** — single line fix, eliminates trivial mDNS spoofing. Critical and cheap.
2. **C2 (Python TOCTOU pin)** — requires an httpx Transport rewrite; start the design now even if the fix lands in 0.2.1.
3. **H1 (Rust Serialize leak)** — single-line change in `serialize_str(&self.inner)` → `serialize_str("<redacted>")`. Add a regression test that round-trips `PairCreateResponse` through JSON and asserts the token is not in the output.

## NEXT TIER (0.2.2)

4. **C3 (Python default-host silent bypass)** — change from warning-then-accept to error.
5. **H2 (Node counter race)** — per-peer mutex via in-flight promise map.
6. **H4 (Tailscale exact match)** — require an allowlist or ACL tag; document loudly.
7. **H5 (Rust zeroize)** — pull in `zeroize`, replace the Drop impl.

---

## NOT FOUND (verified)

- Rust trust-score logic is correct: per-peer `BTreeMap<String, u32>` under `Mutex`, 2xx clears the counter (`client.rs:520`), 3rd auth failure short-circuits with no cycling (`client.rs:539-541`). Good.
- Python trust-score: per-peer `dict[str, int]` under `threading.Lock`, 2xx resets (`_client.py:367`), 3rd auth failure raises `TrustScoreBlockedError` without cycling. Good.
- 60s wall-clock ceiling is enforced across all peer attempts in all three SDKs (Node `client.ts:540`, Python `_client.py:279`, Rust `client.rs:481`). Spec satisfied.
- Equal-jitter backoff: no modulo bias in any SDK (Python/Node use float-random; Rust uses rejection sampling with regression tests).
- POST idempotency gate: all three SDKs require `idempotent: true` on POST for non-429/503 retries. Semi-drift on Python's `_IDEMPOTENT_METHODS` set (covers DELETE/PUT by method type) but not exploitable today.
- `retry_after_us` body precedence over `Retry-After` header: Python and Rust prefer header first, then body (`_retry.py:100-107`, `retry.rs:136-168`). Node does header then body (`retry.ts:64-73`). All three consistent; spec language "retry_after_us body overrides Retry-After header" is not what any SDK implements. If the spec is ground truth, all three SDKs have it backward — flag for confirmation. If the header-first behaviour is intended (standard HTTP semantics), the spec wording is wrong.
- Node `SecretString.toJSON` / `toString` / `util.inspect` — all three redact correctly (`tokenBook.ts:51-62`). Node is the cleanest of the three.

---

**Reviewer**: QE Security Scanner (AQE v3)
**Artifacts read** (absolute paths for cross-reference):
- `/Users/profa/work/cognitum-one/cognitum/repos/sdks/sdks/rust/src/seed/tls_pin.rs`
- `/Users/profa/work/cognitum-one/cognitum/repos/sdks/sdks/rust/src/seed/token_book.rs`
- `/Users/profa/work/cognitum-one/cognitum/repos/sdks/sdks/rust/src/seed/client.rs`
- `/Users/profa/work/cognitum-one/cognitum/repos/sdks/sdks/rust/src/seed/retry.rs`
- `/Users/profa/work/cognitum-one/cognitum/repos/sdks/sdks/rust/src/seed/error.rs`
- `/Users/profa/work/cognitum-one/cognitum/repos/sdks/sdks/rust/src/seed/peers.rs`
- `/Users/profa/work/cognitum-one/cognitum/repos/sdks/sdks/rust/src/seed/config.rs`
- `/Users/profa/work/cognitum-one/cognitum/repos/sdks/sdks/node/src/seed/transport.ts`
- `/Users/profa/work/cognitum-one/cognitum/repos/sdks/sdks/node/src/seed/tokenBook.ts`
- `/Users/profa/work/cognitum-one/cognitum/repos/sdks/sdks/node/src/seed/client.ts`
- `/Users/profa/work/cognitum-one/cognitum/repos/sdks/sdks/node/src/seed/retry.ts`
- `/Users/profa/work/cognitum-one/cognitum/repos/sdks/sdks/node/src/seed/dispatch.ts`
- `/Users/profa/work/cognitum-one/cognitum/repos/sdks/sdks/node/src/seed/config.ts`
- `/Users/profa/work/cognitum-one/cognitum/repos/sdks/sdks/node/src/seed/peers.ts`
- `/Users/profa/work/cognitum-one/cognitum/repos/sdks/sdks/node/src/seed/health.ts`
- `/Users/profa/work/cognitum-one/cognitum/repos/sdks/sdks/node/src/seed/session.ts`
- `/Users/profa/work/cognitum-one/cognitum/repos/sdks/sdks/node/src/seed/discovery/mdns.ts`
- `/Users/profa/work/cognitum-one/cognitum/repos/sdks/sdks/node/src/seed/discovery/tailscale.ts`
- `/Users/profa/work/cognitum-one/cognitum/repos/sdks/sdks/node/src/seed/resources/pair.ts`
- `/Users/profa/work/cognitum-one/cognitum/repos/sdks/sdks/node/src/errors.ts`
- `/Users/profa/work/cognitum-one/cognitum/repos/sdks/sdks/python/cognitum/seed/_transport.py`
- `/Users/profa/work/cognitum-one/cognitum/repos/sdks/sdks/python/cognitum/seed/_token_book.py`
- `/Users/profa/work/cognitum-one/cognitum/repos/sdks/sdks/python/cognitum/seed/_client.py`
- `/Users/profa/work/cognitum-one/cognitum/repos/sdks/sdks/python/cognitum/seed/_retry.py`
- `/Users/profa/work/cognitum-one/cognitum/repos/sdks/sdks/python/cognitum/seed/_config.py`
- `/Users/profa/work/cognitum-one/cognitum/repos/sdks/sdks/python/cognitum/seed/_peers.py`
- `/Users/profa/work/cognitum-one/cognitum/repos/sdks/sdks/python/cognitum/seed/_session.py`
- `/Users/profa/work/cognitum-one/cognitum/repos/sdks/sdks/python/cognitum/seed/discovery/mdns.py`
- `/Users/profa/work/cognitum-one/cognitum/repos/sdks/sdks/python/cognitum/seed/discovery/tailscale.py`
- `/Users/profa/work/cognitum-one/cognitum/repos/sdks/sdks/python/cognitum/_errors.py`
