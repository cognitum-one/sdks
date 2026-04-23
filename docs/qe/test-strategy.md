# Cognitum SDK Test Strategy — v0.3.0 cycle

Derived from the 0.2.0 post-release audit across four domains (security / code-quality / performance / QX+SFDIPOT). See `security-audit.md`, `code-quality-audit.md`, `performance-audit.md`, `qx-sfdipot-analysis.md` for findings.

## Context

Three language SDKs (Node / Python / Rust) implementing the same contract (currently 16 seed endpoints wired, README advertises 71). The QE problem is **parity under divergence**: each language has its own idiom, its own concurrency model, and its own TLS stack — so the same requirement produces three different implementations, and the interesting bugs live in the gaps.

The 0.2.0 audit found bugs in all four quadrants. Strategy for 0.3.0 is built around those gaps.

## Mission

Make drift expensive. Every contract claim in README / CHANGELOG / ADR has an executable test in all three SDKs, runnable from one command, with a pass/fail gate that blocks merge on divergence. The SDKs can diverge in implementation; they must not diverge in behaviour.

## Quality risks (prioritised)

| # | Risk | Evidence | Impact |
|---|------|----------|--------|
| R1 | TLS-pin bypass on Node (startsWith w/o length floor) | security-audit C1 | MITM on mesh |
| R2 | Python TLS-pin TOCTOU (out-of-band verify socket) | security-audit C2 | MITM on pinned peers |
| R3 | Python silent CERT_NONE on `cognitum.local` / 169.254.* | security-audit C3 | MITM on default host |
| R4 | `prefer` option diverges across all 3 SDKs — Python ignores it entirely | code-quality-audit | Routing behaviour unpredictable |
| R5 | Rust SecretString::Serialize leaks raw token | security-audit H1 | Token disclosure |
| R6 | Node trust-score counter race | security-audit H2 | 3-strike bypass |
| R7 | Tailscale prefix is substring not exact | security-audit H4 | Peer impersonation on shared tailnet |
| R8 | Env-var resolution broken in Python + Rust (README lies) | qx-sfdipot | Silent auth failures |
| R9 | README claims 71 endpoints; 16 exist | qx-sfdipot | Trust / adoption |
| R10 | Rust error taxonomy pre-ADR (magic-string encoding of 5 variants) | code-quality-audit | Callers can't `match` errors |
| R11 | Python retry sleeps past 60s budget | performance-audit F16 | Request doomed, budget wasted |
| R12 | Node health probe pollutes EMA with `probeTimeout` | performance-audit F14 | Closest-first routing wrong |
| R13 | `prefer=local-first` means different things in Node vs Rust vs Python | code-quality-audit | Silent behavioural drift |
| R14 | Rust `pair.delete()` missing CallOptions (sole resource lacking it) | code-quality-audit | Contract break |
| R15 | No performance baselines / CI gates | performance-audit F20-F21 | Fixes un-guarded |

## Strategy

### S1 — Contract test suite in ONE language, executed against all three

Pick the existing pattern: a single YAML or JSON fixture set under `docs/adr/contract-tests/` describing each expected behaviour as a reproducible HTTP exchange + assertion. A tiny per-language harness consumes the fixture and asserts against its own SDK. Add these fixtures before writing SDK code for new 0.3.0 features.

- **Covers:** R4, R5, R10, R13, R14
- **Why:** drift is detected on the fixture, not in three parallel test files that drift themselves.
- **Owner:** SDK maintainers + QE at refinement.

### S2 — Security conformance harness (the non-negotiables)

A dedicated `conformance/security/` test suite, one implementation per SDK, testing the same scenarios:

- TLS pin mismatch → hard error, never insecure fallback (per-SDK: malformed TXT, short fp, mismatched CA).
- SecretString redaction — repr / JSON / toJSON / Debug / Display / print / stringify / format! — each must redact. Serialization round-trip must be documented per wrapper class.
- Trust-score counter — 3-strike under N concurrent requests (N=2, 4, 8, 16) must block at or before attempt 3.
- `insecure: true` on non-localhost → warn on EVERY request (per ADR-0007) AND refuse if host resolves to a routable address (feature-flagged prod guard).
- Env var precedence: set `COGNITUM_API_KEY` in env, construct client without arg, assert request header.

Runs on PR. Red gates merge.

- **Covers:** R1, R2, R3, R5, R6, R8

### S3 — Mesh failover property tests (metamorphic)

Use property-based testing (fast-check / hypothesis / proptest) to generate mesh scenarios:

- Random peer count (1..7), random 2xx/5xx/timeout sequences, random `prefer` / `consistency` / `peer` overrides.
- **Metamorphic oracle 1:** total attempt count never exceeds `N_peers × retries_per_peer`, regardless of failure pattern.
- **Metamorphic oracle 2:** wall-clock elapsed ≤ `timeouts.total` in every run (currently violated in Python — see F16).
- **Metamorphic oracle 3:** for a session-sticky request chain, all calls hit the same peer unless it transitions to Unhealthy.
- **Metamorphic oracle 4:** `prefer=closest` ordering has the same top-1 peer across three back-to-back calls (stability under no load change).

- **Covers:** R4, R11, R12, R13

### S4 — Performance baseline + regression gate

Before touching perf-sensitive code in 0.3.0:

1. Commit `benches/baseline.criterion/` (Rust), `bench/baseline.json` (Node, Python).
2. Add a `ci-bench` job that runs on `main` push, records the new numbers, and fails if SDK overhead regresses > 1.3× baseline.
3. Extend benches per performance-audit F20: POST body, retry cycle, PeerSet ops, cold-start, header/URL construction.

- **Covers:** R15; guards future perf work.

### S5 — Documentation conformance test

One linter script that walks README.md + ADRs and asserts:

- Every endpoint claimed in the surface-map code block exists in at least one `resources/*.ts|py|rs`.
- Every env var named in the README has a corresponding read in code (grep-based).
- The feature-at-a-glance list doesn't claim capabilities grep can't find.

Runs on PR. Red blocks merge.

- **Covers:** R9 — README claiming 71 endpoints when only 16 exist is a documentation defect, not a copy-edit issue. Test it.

### S6 — Exploratory charters (SBTM)

Structured exploration for the classes of bug that elude scripted tests: parity drift, oracle problems, timing. Separate document: `exploratory-charters.md`. Two sessions per SDK per release cycle, 90 minutes each, debriefed into a new GitHub issue or "nothing found" note.

### S7 — Release gate

Before tagging 0.3.0:

- All S1–S5 gates green on main.
- At least one S6 session complete per SDK, debrief filed.
- Risks R1–R3 (criticals) remediated or explicitly deferred with a CVE tracking entry.
- Cross-SDK live matrix (the 30/30 Phase 2+3 scenarios from 0.2.0 changelog) re-run against the current SHA on all three.

## Test pyramid allocation (per SDK)

| Layer | Coverage target | Example |
|---|---|---|
| Unit | 85% line, 75% branch | `jitter_ms` distribution, `PeerSet.preferOrder` ordering, SecretString redaction |
| Integration | every resource × (happy / 4xx / 5xx / timeout) | `store.ingest` round-trip, `mesh.peers` response parsing |
| Contract (S1) | every behaviour in README / ADR | Retry-After vs retry_after_us precedence, CallOptions threading |
| Property (S3) | mesh state machine, retry loop, redaction | metamorphic oracles above |
| Security conformance (S2) | TLS pin, SecretString, trust-score, env resolution | hard-fail on any drift |
| E2E live | Phase 2+3 matrix on real seed | 30/30 parity |
| Perf (S4) | status / POST / retry / peer ops | baseline + 1.3× gate |
| Exploratory (S6) | charters per cycle | debriefed |

## What 0.2.0 taught us

- **Naive SAST is noise.** The 10 "critical hardcoded secrets" were 10 false positives (JSDoc + test fixtures). A grep with `# nosec` markers and a `.security-allowlist.yaml` per SDK would kill it.
- **Parallel implementations drift even with good intent.** `prefer` has three different meanings across three SDKs that all claim to implement the same spec. Contract tests would have caught it before release.
- **Documentation silently lies.** "71 endpoints" sailed through review because no one ran `grep` against it. A linter test flips that.
- **Security fixes need property tests.** The trust-score 3-strike counter is correct per-call in all three SDKs; it's wrong under concurrency in Node. Single-threaded tests all pass.

## Out of scope

- Fuzzing the seed wire protocol (seed firmware's responsibility, not SDK's).
- Cross-runtime interop (SDKs don't talk to each other).
- Cloud control-plane (`api.cognitum.one`) — this strategy covers the seed-client surface only.
- Mobile / WASM targets — flagged in qx-sfdipot but out of 0.3.0.

## Decision hooks

- **If** contract tests (S1) can't be written in time for 0.3.0 cut, **then** make the S2 security harness and S5 doc linter non-negotiable and ship behaviour drift as a known-deferred risk.
- **If** remediation of R1–R3 slips past the 0.3.0 RC, **then** issue 0.2.1 patch release for the 3 criticals rather than holding 0.3.0 hostage.
- **If** perf baseline (S4) shows > 1.3× regression during the cycle, **then** stop feature work, bisect, fix before continuing.
