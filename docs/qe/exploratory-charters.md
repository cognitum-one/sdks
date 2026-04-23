# Exploratory Charters — Cognitum SDKs

Session-Based Test Management (SBTM) charters for the 0.3.0 cycle. Each charter is a 90-minute timeboxed session with a clear mission, a list of in-scope areas, suggested heuristics, and a required debrief. Two sessions per SDK per cycle; debriefs filed to a shared `session-log.md` per charter. Follow-up bugs → GitHub issues.

RST heuristics in use: SFDIPOT, FCC CUTS VIDS (test types), HICCUPPS (consistency oracles), CRUSSPIC STMPL (coverage), POISED (quality criteria).

## Charter template

```
Charter: <title>
Area: <SDK / feature>
Mission: <1-2 sentences>
Tester: <name>
Duration: 90 min
Date: YYYY-MM-DD

Setup:
  - <env, keys, peers>

Oracles:
  - <consistency model, reference model, metamorphic rule>

Test ideas to pursue:
  - <5-10 ideas; strike when covered, annotate when surprised>

Out of scope:
  - <what this charter does NOT cover>

---
Debrief (filed at end):
  Summary: <2-3 sentences>
  Bugs filed: <#123, #124>
  New risks: <list>
  New test ideas for scripted suite: <list>
  Coverage walked: <areas actually touched>
  Follow-up charter: <next session candidate>
```

---

## Charter 1 — "Drift hunt" (cross-SDK parity)

**Area:** Node + Python + Rust seed-client surface.

**Mission:** Drive the same sequence of operations through all three SDKs against the same seed and find behaviours that differ where the contract says they shouldn't.

**Setup:** live seed (`cognitum.local:8443` or USB-gadget 169.254.42.1). Three terminal panes, one per SDK. Same API key / pairing token in each.

**Oracles:**
- Consistency-with-itself: same input → same output across runs.
- Reference model: the `docs/adr/` ADRs as truth. Where they diverge from behaviour, either the ADR or the SDK is wrong.
- Metamorphic: `status()` response shapes must deserialize to the same domain model in all three.

**Test ideas:**
1. Call `status()` in all three. Does `device_id` / `deviceId` capitalize correctly? Is `epoch` a number or string?
2. Call `pair.create()` → capture response. Print with `console.log` / `print(repr(x))` / `println!("{:?}", x)`. Does each redact the token? Are byte-counts reported consistently?
3. With mesh of 3 peers, stop one peer mid-request. Does each SDK cycle in the same order?
4. Pass `CallOptions{ prefer: "random" }` 20 times. Does Python actually randomise? (expected: no, per R4)
5. Pass `CallOptions{ peer: "<key>" }` for an unknown peer. Same error class in all three? Same message template?
6. Invoke `store.query()` with a `filter` field (Python only accepts it). What does the seed return? Is Python silently sending a field that's ignored, or is it doing something different?
7. Delete pairing with `pair.delete()` — does Rust accept `CallOptions`? (expected: no, per R14)
8. Trigger a 429 with `Retry-After: 3` + body `{"retry_after_us": 1500000}`. Confirm each SDK sleeps 1.5s (body wins, per spec) — or 3s (header wins, per current impl).

**Out of scope:** cloud API, MCP transport, non-seed features.

---

## Charter 2 — "TLS footguns"

**Area:** sdks/*/seed/transport.* + tls_pin / PinVerifier / mDNS TXT parsing.

**Mission:** Find conditions under which the SDK lets through a cert it shouldn't.

**Setup:** `mitmproxy` or `openssl s_server` with self-signed and mismatched-CA certs ready. Local DNS aliases: `cognitum.local`, `evil.local`.

**Oracles:**
- ADR-0007 says: pin mismatch → hard error, never fallback. Test the assertion.
- Metamorphic: two independent TLS connections to the same hostname must see the same cert. Any SDK that separates pin-verify from request (Python, per C2) risks drift.

**Test ideas:**
1. Node: advertise `fp=ab` (2 hex chars) via mDNS. Does `startsWith` accept it? (expected: yes, per C1 — known bug.) If so, does it successfully connect to any cert whose fingerprint starts with `ab`?
2. Python: run MITM that answers port-443 `ssl.get_server_certificate` with real cert, then answers the actual httpx request with forged cert. Does verify-then-request let the forged one through? (expected: yes, per C2.)
3. Python: set default host `cognitum.local`. Present self-signed cert. Is the connection allowed? (expected: yes with only a `warnings.warn`, per C3.) Is the warning captured in a log sink someone in prod would see?
4. Rust: present cert with no fingerprint available via mDNS. Does the fallback path require CA pin, or silently accept?
5. Advertise duplicate `fp=` TXT entries with different values. Which one wins? Does any SDK accept either?
6. Advertise `fp=sha256:<64hex>` vs `fp=sha1:<40hex>` vs `fp=<64hex without prefix>`. Parse robustness per SDK.
7. Start with a valid pin, connect, cache session. Rotate cert on the seed. Does the next request detect mismatch, or reuse the cached connection?
8. In insecure mode, does the SDK log a warning on EVERY request (per ADR-0007), or once (current impl)?

**Out of scope:** certificate authority issuance, OCSP.

---

## Charter 3 — "Redaction survival"

**Area:** SecretString / tokenBook / _token_book implementations.

**Mission:** Exhaust ways to coerce a `SecretString`-wrapped token into leaking its raw value.

**Setup:** a pairing token valued `T0P-5ECRET-7OKEN` loaded into `PairCreateResponse.token` in each SDK.

**Oracles:**
- Contract: any public serialization of the wrapped type must not contain the raw value.
- HICCUPPS — History-consistent: what did 0.1.x do? What should the wrapper do?

**Test ideas:**
1. Node: `console.log(resp)` / `console.log(resp.token)` / `JSON.stringify(resp)` / `util.inspect(resp)` / `structuredClone(resp)`. Any leak?
2. Node: `resp.token.valueOf()` / `String(resp.token)` / template literal `\`${resp.token}\``. Any leak?
3. Python: `print(resp)` / `repr(resp)` / `f"{resp}"` / `str(resp)` / `json.dumps(dataclasses.asdict(resp))` / `pickle.dumps(resp)`.
4. Python: `copy.deepcopy(resp)` preserves wrapper? Round-trip via `dict(resp.__dict__)`?
5. Rust: `format!("{:?}", resp)` / `format!("{}", resp)` / `serde_json::to_string(&resp)` / `Display` / `Debug` of `Arc<SecretString>`. Per H1 — Serialize leaks today.
6. Rust: `Debug` after `clone()`? After move into another struct? After `Drop` — does memory zero?
7. All three: send the raw SDK response over `console.log` / `logger.info` / `tracing::info!`. Does the logger see redacted?
8. All three: serialize into an error message. Some SDKs include response bodies in errors — does the token leak via error reporting?

**Out of scope:** attacks at the OS level (core dump inspection, debugger attach).

---

## Charter 4 — "Mesh under partial failure"

**Area:** PeerSet state machine + failover + wall-clock budget.

**Mission:** Induce non-obvious peer-cycling behaviours and confirm no request exceeds the 60s budget nor burns the seed's trust budget.

**Setup:** 5-peer mesh. Use `toxiproxy` or `tc netem` to inject latency / drops on specific peers.

**Oracles:**
- Contract: total elapsed ≤ 60s wall clock.
- Contract: total attempts ≤ N_peers × retries_per_peer.
- Metamorphic: a request that cycles through all peers ending in failure should NOT restart from the first peer if that would exceed budget.

**Test ideas:**
1. Peer A: 100% 503. Peer B: 500ms delay + 2xx. Peer C: 2xx immediate. With `prefer=closest`, does failover go A→B→C or A→C (skipping degraded B)?
2. Peer A: 429 with `Retry-After: 120`. Other peers healthy. Does SDK pin A for 120s but still serve next request via B/C?
3. All peers: 401. Does the request abort at 3rd 401 across the WHOLE mesh, or 3 per peer? (Spec says per-peer. Confirm in code and observe.)
4. Force a scenario where the retry budget permits attempts but wall-clock is exhausted mid-sleep. Python-specific: per F16, Python can sleep past deadline.
5. Toggle one peer between 2xx/5xx rapidly. Does EMA stabilise or oscillate? Does Node's `probeTimeout` poisoning (F14) cause the peer to be mis-ranked?
6. Call with `CallOptions{ consistency: "session" }`. Kill session-pinned peer mid-chain. Does next call in the session rebind or error?
7. Call `rediscover()` while a request is in flight. Does the in-flight request see the new peer list or the old?
8. Two concurrent requests with different `prefer` values — does a shared `markSuccess` interfere?

**Out of scope:** seed firmware behaviour; discovery provider bugs (covered in Charter 5).

---

## Charter 5 — "Discovery ambushes"

**Area:** MdnsDiscovery + TailscaleDiscovery (all three SDKs).

**Mission:** Drive discovery against adversarial / malformed network conditions.

**Setup:** control of local mDNS responder (dns-sd, avahi-publish) + ability to mock `tailscale status --json` via `PATH` override.

**Oracles:**
- Contract: `cognitum-*` prefix is exact match on hostname (per spec; per R7 currently substring in some SDKs).
- Contract: TXT parsing tolerates malformed input without crash.

**Test ideas:**
1. Announce two hosts: `cognitum-legit` and `evilcognitum-abc`. Does Tailscale filter accept only the prefix-matching one? (per R7, expected: Node/Python fail — substring matches both.)
2. Announce `cognitum-🤖` (non-ASCII). Parse safely? Hostname resolution works?
3. mDNS responder advertises 50 identical `cognitum-*` entries. Each SDK enumerate all 50?
4. mDNS TXT with no `fp=` entry. Does SDK fall through to CA pin mode, or refuse, or insecure?
5. mDNS TXT with `fp=garbage$$@!`. Reject gracefully?
6. Tailscale output missing `Peer` field entirely. Crash, empty peer list, or error?
7. `tailscale status --json` hangs (never returns). SDK blocks forever? Has a timeout? (per perf F13 — Python has 10s, Node has none.)
8. Announce a service that looks like a seed but isn't (e.g. wrong port). Does SDK attempt pair negotiation and fail quickly?
9. Rapid fire `client.rediscover()` 10× in a second. Does it spawn 10 `tailscale` subprocesses? (per perf F13 — yes, no cache.)

**Out of scope:** attacks against the tailnet coordination server; mDNS reflector abuse.

---

## Charter 6 — "Oracle problems" (by design)

**Area:** Decisions where correctness isn't locally verifiable — failover choices, EMA ordering, discovery freshness.

**Mission:** For each of the five oracle problems identified in the qx-sfdipot analysis, prototype a reference model / metamorphic rule / consistency check that could be promoted into a scripted test.

**Oracles:**
- The goal IS to invent oracles. Document each new oracle found.

**Test ideas:**
1. "Did failover pick the RIGHT peer, or just A peer?" — write a reference model that sorts peers by latency-EMA + health-state; compare SDK's selection to model's top-1.
2. "Is the discovered peer the CURRENT peer, or a stale one?" — TTL-based staleness check; SDK should treat any peer entry > 2× TTL as invalid.
3. "Did the trust-score counter correctly attribute to THIS peer?" — fingerprint request by peer.key; counter state must map 1:1.
4. "Is 60s the right budget for THIS call?" — per-request context: short calls should fail fast; long calls bounded by total. Identify calls where 60s is already wrong.
5. "Did the EMA converge, or is it still transient?" — window-over-window comparison; consider any decision made on < 5 samples as low-confidence.

**Out of scope:** turning every idea into code this session. Document and hand to scripted-suite owners.

---

## Charter 7 — "Installer + feature-flag UX"

**Area:** package install paths, optional extras, feature gates.

**Mission:** Walk through a fresh-install experience for each SDK against clean machines. Time to first successful seed call.

**Setup:** three fresh VMs / containers per SDK (Node 18/20/22, Python 3.10/3.11/3.12, Rust stable/beta). No cached caches.

**Oracles:**
- Zero → first-successful-call time under 5 minutes.
- Error messages name the fix, not the symptom.

**Test ideas:**
1. `pip install cognitum` — does it work without `[mdns]`? What if I try `MdnsDiscovery` without the extra? Is the import-error helpful?
2. `npm install @cognitum/sdk` — does the CLI `cognitum` binary appear on PATH? `cognitum --version` → does it match package.json? (per qx-sfdipot — currently hardcoded 0.1.2.)
3. `cargo add cognitum-rs` — does the default feature set work, or does it fail-to-link without `seed`?
4. `cargo add cognitum-rs --features seed,mdns` but no system mdns libs — linker error? Pre-build check?
5. Fresh `COGNITUM_API_KEY` env var but no constructor arg. Does Python actually use it? (per R8 — no.)
6. Mis-spell the env var: `COGNITUM_APIKEY` (no underscore). Does the SDK error say "did you mean COGNITUM_API_KEY"?
7. Install on ARM macOS vs x86_64 Linux vs arm64 Linux. Rust: does native compile work? Python: wheel available? Node: prebuilt napi bindings?
8. First-call experience: `const c = new SeedClient(); await c.status();` with no endpoint configured. Error message? Stack trace noise? Actionable?

**Out of scope:** IDE integrations, editor plugins.

---

## Scheduling

| Sprint | Charters (per SDK) |
|---|---|
| 0.3.0-alpha.1 | 1 (drift hunt), 3 (redaction) |
| 0.3.0-beta.1 | 2 (TLS footguns), 4 (mesh failure) |
| 0.3.0-rc.1 | 5 (discovery ambushes), 7 (installer UX) |
| 0.3.0 (release) | 6 (oracle problems) as part of retrospective |

## Session log location

- `docs/qe/sessions/YYYY-MM-DD-charter-N-tester.md`
- Index: `docs/qe/sessions/README.md` — table of all sessions with summary, bugs filed.

## Debrief discipline

Every session ends with a debrief file, even if nothing was found. "Nothing found" is a data point — it tells future sessions which paths are exhausted. No debrief = session didn't happen.
