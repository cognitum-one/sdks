# ADR 0025b: Meta Proxy Lifecycle, Integrity, and GA Gates

- **Status:** Proposed
- **Date:** 2026-07-18
- **Deciders:** Cognitum SDK Working Group, Meta Proxy owner, MetaHarness owner, Security, SRE, Release Engineering, Developer Experience
- **Scope:** Meta Proxy lifecycle SDK integration (`sdks/node`, `sdks/python`, `sdks/rust`)

## Context

ADR-0025a defines the HTTP client, routing planes, and consent behavior for an
already-running Meta Proxy. This companion ADR owns discovery, signed install,
configuration integrity, authentication state, process/service lifecycle,
updates, and the paired GA gates. ADRs 0019 through 0023 define common product,
contract, transport, credential, and failure rules. ADR-0026a owns the
structured MetaHarness process bridge, ADR-0026b owns its process and npm/npx
supply chain, ADR-0029 owns packaging, and ADRs 0030a and 0030b own release
conformance and rollout.

The audit baseline is
`cognitum-one/meta-proxy@43427e92ee0527413ca71744b538035537e0b6ef`.
`Cargo.toml:2-3` reports version `0.4.1`, while current README and lifecycle pairing
still reference `0.4.0`. The public `meta-proxy-dist` repository contains
release assets, not implementation source.

The Proxy binary directly supports foreground serve, login, auth status, and
logout. It does not implement install, start, stop, service management, logs,
update, or uninstall commands. Accepted Meta Proxy ADR-307 assigns those
responsibilities to MetaHarness or ruflo. Its release contract uses platform
archives, `SHA256SUMS`, and a raw Ed25519 signature over the exact manifest
bytes, with the public key pinned by the consumer.

Current local state requires stronger lifecycle treatment:

- configuration has no schema version and malformed TOML silently resets the
  full in-memory configuration to defaults;
- unknown config fields are not rejected;
- bare default plane is `passthrough`, while installer decisions promise
  local-only;
- OAuth, API-key, sponsored, consent, installation, and usage state share the
  per-user ruflo directory;
- the sponsored ledger is unlocked, non-atomic, and fail-open on corruption;
- non-loopback bind only warns, and CORS permits any origin/method/header;
- PID, port, and token presence alone do not prove process identity or ownership.

Representative as-built anchors are `src/config.rs:47-57,350` for bind/default
and fail-open parsing, `src/lib.rs:31-49` for the runtime surface, and
`README.md:198,273` for the local token lifecycle.

An SDK cannot safely reconstruct three independent installers and supervisors
from these files. Lifecycle ownership must remain centralized and explicit.

## Decision

Add `MetaProxyManager` over an injected `MetaProxyLifecycleProvider` interface
defined in the shared `agentic` namespace. The Meta Proxy module imports only
that interface. The official implementation is the versioned
`MetaHarnessProxyLifecycleProvider` adapter from ADR-0026a; applications inject
it explicitly. The manager is separate from `MetaProxyClient`, never acts as an
inference transport, and performs no I/O during construction.

### D1. Public manager topology and maturity

```text
manager.discover
manager.install
manager.start
manager.stop
manager.status
manager.logs
manager.update
manager.uninstall
manager.auth.login
manager.auth.status
manager.auth.logout
```

| Group | Target maturity | Conditions |
|-------|-----------------|------------|
| Discover, verified install, foreground start, owned stop, status | Stable | Structured bridge, signed assets, compatibility, ownership, and readiness pass all platform fixtures |
| Login, auth status, logout | Stable | Credential mutation, refresh, redaction, non-revocation semantics, and reload are contracted |
| Managed service install, logs, update, uninstall | Preview | Platform service and recovery behavior remain evolving |
| Config mutation and internal reload | Internal | Only validated manager operations; no public raw-TOML API |
| Non-loopback deployment | Dangerous preview | Separate security contract required by ADR-0025a |

If the injected provider lacks a structured lifecycle operation, the method is
unsupported. The SDK does not scrape human output, import the MetaHarness
product from Meta Proxy, or substitute an unversioned shell command.

### D2. Manager and process types

```text
MetaProxyLifecycleProvider {
  capabilities()
  discover(), install(), start(), stop(), status(), logs()
  update(), uninstall()
  login(), authStatus(), logout()
  mintWorkloadCapability(claims)
}

MetaProxyManagerConfig {
  lifecycle_provider,
  release_channel,
  pinned_signing_key,
  expected_version_range,
  state_directory?,
  readiness_timeout,
  telemetry
}

MetaProxyProcessHandle {
  instance_id,
  pid,
  origin,
  product_version,
  protocol_version,
  owner_nonce,
  started_at,
  lifecycle_mode,
  state_directory_identity
}

LifecycleMode = ephemeral_foreground | attached_foreground | user_service
```

Handles are origin-, user-, state-directory-, instance-, and owner-bound. A PID
alone is never ownership proof because it can be reused. Stop and uninstall
require ownership proof or an explicit adoption flow with fresh authenticated
status and operator intent.

Closing `MetaProxyClient` never stops a process. Closing an owning manager stops
only a configured ephemeral child. Attached processes and user services survive
by default. A local wait timeout does not imply the process stopped.

### D3. Configuration schema and state transaction

The future language-neutral management schema is:

```text
ProxyConfig {
  schema_version,
  bind,
  default_data_plane,
  local_backend_url,
  cognitum_api_base,
  sponsored_consent_reference?,
  sponsored_daily_cap_usd,
  power_saver_consent_reference?,
  training_share_consent_reference?,
  injected_token_reference?,
  credential_references,
  revision
}
```

Public callers never receive raw credential values. The manager does not
deserialize and rewrite current TOML optimistically. Stable configuration
requires a versioned validated MetaHarness operation or future authenticated
Proxy control endpoint with compare-and-swap revision.

Normative writes are:

1. read and validate known schema/revision;
2. reject unknown security-sensitive fields and invalid plane/URL/consent;
3. materialize a complete candidate without secrets in diagnostics;
4. write a private temporary file, fsync where supported, and atomically rename;
5. retain a bounded last-known-good version;
6. request exact-token reload through the owning bridge;
7. verify new revision and effective plane through authenticated status;
8. roll back on failed verification without silently choosing defaults.

Malformed current state fails closed and returns a recovery error. It never
selects passthrough, cloud, sponsor, or training behavior as a recovery default.

### D4. Discovery, start, readiness, and stop

The lifecycle state machine is:

```text
absent -> installed -> starting -> ready -> stopping -> installed
                         |          |
                         v          v
                       failed     exited
```

Discovery considers only an injected handle, a manager-owned install record, or
an explicit executable whose signed identity and handshake validate. Ambient
PATH and an arbitrary listener on port 11435 are not trusted discovery.

Start launches the exact verified binary with an allowlisted environment. It
does not put tokens in arguments. Stdout/stderr use bounded content-free
supervisor logs. A port collision fails and does not send a bearer to the
listener.

Before spawn, the manager creates a one-time 256-bit readiness challenge and
passes it through a protected inherited pipe, not argv, environment, or the
filesystem. After successfully binding, the exact child returns the challenge
proof, instance ID, bound origin, binary digest, and version on that pipe. Only
then may the manager send the local bearer to authenticated status. The current
binary does not yet implement this channel, so stable managed start is blocked
until the paired bridge and binary do.

Readiness then requires authenticated status proving expected instance, binary
version, protocol major, bind, state-directory identity, and compatibility. A
TCP connection, PID, open port, or bearer-authenticated response without the
owned-child challenge is insufficient. Proposed default readiness budget is 10
seconds, initial poll 100 ms, capped at 1 second with jitter. Tests use a virtual
clock.

Stop first requests graceful termination of the owned instance, waits a bounded
period, then may terminate the owned process tree. It never signals a PID whose
instance/owner proof changed. Force termination is recorded. Windows job,
Unix process-group, launchd user-agent, and systemd user-service semantics are
platform adapters with the same ownership invariant.

### D5. Authentication state lifecycle

Login supports browser or headless/manual flows only through explicit manager
methods and interactive policy. OAuth PKCE state, callback timeout, refresh,
expiry, rotation, and storage remain Proxy-owned. The manager receives redacted
status, not tokens.

Current cloud credential precedence is injected workload token, stored OAuth,
then API key. The SDK exposes the selected source as a non-secret enum. It does
not read Claude or provider credential files itself.

Logout clears exactly the documented local credential classes. Current logout
does not prove upstream revocation and does not necessarily reset plane,
injected token, sponsored key, consent, or provider credential. The facade
returns a typed disposition for each class rather than one misleading
`logged_out: true` boolean.

Config reload accepts only the raw local bearer and is internal. A MetaHarness
workload capability cannot broaden itself by invoking reload.

### D6. Signed installation and update integrity

MetaHarness owns release consumption. The manager requests this verified flow:

1. resolve an exact version and platform triple from the pinned compatibility
   table;
2. download manifest, signature, and archive over authenticated HTTPS;
3. verify Ed25519 over the exact `SHA256SUMS` bytes;
4. verify selected archive name and digest;
5. extract into private staging with traversal, link, file-count, and size
   defenses;
6. prove binary identity/version without untrusted postinstall scripts;
7. atomically replace the per-user binary;
8. create or validate local token and ACLs;
9. validate configuration before start;
10. emit artifact version, manifest digest, and compatibility evidence.

Unsigned releases, source-only tags, missing mirrored assets, version mismatch,
unknown triples, mutable registry `latest`, arbitrary PATH binary, `cargo
install`, and unsigned npm fallback all fail closed.

The current release targets are macOS arm64/x64, Linux arm64/x64, and Windows
x64. A target becomes supported only with signed assets and install, tamper,
start, readiness, stop, update, and uninstall conformance.

Update stages a fully verified version, checks compatibility and config
migration, and replaces atomically. It never auto-updates. Restart is explicit
unless the caller selected a named managed-update operation. Failed readiness
restores the prior binary/config where possible and reports recovery evidence.

Uninstall stops only the owned instance/service and deletes only manifest-owned
artifacts after explicit confirmation. Credentials, consent, or logs with
separate retention are removed only when the caller names those classes.

### D7. Filesystem and local-network integrity

Token, config, injected credential, install, usage, PID, and ownership files
must be regular, expected-user-owned, bounded, non-symlink files with `0600` or
platform-equivalent ACLs where secret. State directories reject unsafe parent
ownership and traversal. Secret writes use atomic replace and avoid backups that
weaken permissions.

Diagnostics redact home directories and never show contents, OAuth values,
provider keys, local bearer, capability HMAC, signing private key, or consent
secret. File validation runs before any value is parsed or sent.

The manager enforces literal loopback for stable mode. Non-loopback remains the
separate dangerous capability in ADR-0025a and cannot be enabled by ambient
`RUFLO_PROXY_BIND` during stable managed start. Current warn-only bind and
allow-any CORS behavior block stable remote management.

### D8. Sponsor ledger and state integrity

Stable sponsor management requires replacing current JSON accounting with:

- schema and pricing version;
- interprocess lock or transactional store;
- atomic durable commit;
- fail-closed corruption and unavailable storage;
- monotonic operation identity plus wall-clock billing period;
- authoritative server reconciliation;
- bounded, auditable repair requiring explicit operator action.

Tests cover concurrent Proxy processes, crash at every write boundary, malformed
and truncated state, date rollover, clock rollback/advance, disk-full,
permission loss, price change, and server/client disagreement. The SDK never
repairs corruption by resetting spend to zero.

### D9. Lifecycle observability

ADR-0028 rules apply. Safe lifecycle attributes are operation, process state,
lifecycle mode, Proxy/bridge/protocol versions, platform triple, ownership
result, readiness latency, categorized exit, artifact digest prefix, config
revision, rollback result, and consent evidence ID.

Prompts, outputs, credentials, filesystem contents, full paths, command
environment, and raw supervisor streams are excluded. Logs cannot claim a
successful install from a downloaded file alone; signature, digest, atomic
install, handshake, and readiness are separate evidence states.

### D10. Paired GA gates

No manager operation becomes stable until applicable gates pass:

1. publish Proxy lifecycle, config, status, credential disposition, and artifact
   schemas in the ADR-0020 bundle;
2. publish the ADR-0025b-owned lifecycle-provider schema and a versioned
   ADR-0026a MetaHarness adapter operation that consumes it for every stable
   manager method;
3. align Cargo, binary status, README, signed release assets, distribution
   mirror, and MetaHarness compatibility versions;
4. make installed local-only configuration an executable invariant;
5. add config schema, strict validation, revision, last-known-good recovery, and
   fail-closed parse behavior;
6. replace sponsored spend state with locked atomic accounting and server
   reconciliation;
7. prove exact-token reload cannot be invoked by workload capability;
8. publish login/logout per-credential dispositions and upstream-revocation
   limits;
9. enforce loopback for stable managed mode and prevent ambient bind override;
10. implement signed install/update/rollback fixtures on every supported target;
11. implement the protected owned-child readiness challenge before transmitting
    the local bearer;
12. prove port-collision, PID-reuse, crash, orphan, stale-lock, and partial
    uninstall recovery;
13. pass ADR-0025a's route, plane, receipt, forwarding, error, and consent gates;
14. run two consecutive paired MetaHarness and Proxy releases through ADR-0030a
    conformance and ADR-0030b rollout before stable promotion.

### D11. Migration and rollout

1. pin exact Proxy, MetaHarness bridge, artifact key, and compatibility range;
2. release read-only discovery/status through preview;
3. add signed install, ephemeral foreground start, readiness, and owned stop;
4. add login/auth status/logout with redacted dispositions;
5. add platform user-service adapters separately;
6. add explicit update/rollback and uninstall after recovery fixtures;
7. keep raw config mutation, internal reload, remote bind, and automatic update
   out of stable public APIs.

Applications may use ADR-0025a with an externally-managed process. Manager
adopters remove duplicate download, token, PID, and service logic. Migration
does not adopt, stop, update, or delete an existing process without explicit
ownership confirmation.

## Consequences

### Positive

- Installation and service policy remain centralized in MetaHarness instead of
  drifting across three SDKs.
- Signed artifacts, config revisions, ownership, and readiness become auditable
  evidence.
- Corrupt state fails closed instead of silently changing plane or payer.

### Negative and quantified trade-offs

- Five platform targets require at least five install, tamper, port-collision,
  ownership, update, rollback, and uninstall fixture sets per paired release.
- Authenticated readiness adds one local request and a default maximum 10-second
  start budget; healthy starts should complete without using the full budget.
- Retaining one prior binary and config for rollback roughly doubles installed
  binary/config disk during update.
- Planning estimate is 8 to 12 engineering days for the bridge, verifier, state
  transaction, and shared ownership logic, plus separate OS service work.
- Explicit update and adoption add user steps but eliminate silent process and
  supply-chain mutation.

### Biggest failure mode and mitigation

The biggest failure is trusting or mutating the wrong local process or artifact:
a tampered binary, foreign port listener, reused PID, corrupt config, or
unverified update can steal prompts/tokens or change routing. Signed exact
artifacts, authenticated instance readiness, ownership nonces, transactional
state, loopback enforcement, and fail-closed recovery mitigate it.

## Alternatives considered

| Option | Benefit | Rejected because |
|--------|---------|------------------|
| Auto-start in client constructor | Convenience | Hidden install, consent, port, and ownership side effects |
| Reimplement lifecycle in every SDK | Native UX | Three security and service implementations drift |
| Trust PATH or open port | Easy discovery | Does not prove product, version, token audience, or ownership |
| Edit TOML directly | No bridge work | Current parse can silently default and corrupt secrets |
| Auto-update | Fast patches | Unconsented supply-chain and compatibility mutation |
| PID-only stop | Simple | PID reuse can terminate unrelated processes |

## Compliance and verification

CI MUST prove:

1. manager construction performs zero I/O;
2. bridge absence or unknown version blocks before install/process mutation;
3. every manifest, signature, digest, archive, binary, and platform tamper fails;
4. unsafe archive paths, links, counts, and sizes fail before extraction;
5. malformed config and every interrupted write restore or preserve known-good
   state without selecting cloud/sponsor/passthrough;
6. readiness rejects foreign listener, wrong instance, wrong version, wrong
   state directory, and incompatible protocol before bearer transmission;
7. stop/update/uninstall cannot affect unowned or PID-reused processes;
8. workload capability cannot reload or broaden configuration;
9. logout reports each credential class and never overclaims revocation;
10. ledger concurrency, corruption, disk, date, clock, and reconciliation fail
    closed;
11. stable managed mode ignores ambient non-loopback bind and proxy variables;
12. all secret canaries remain absent from argv, environment diagnostics,
    stdout/stderr, logs, traces, errors, files with weak ACLs, and result JSON.

### Executable acceptance test

```text
cd sdks/node   && npm test -- meta-proxy-lifecycle-conformance
cd sdks/python && pytest -m meta_proxy_lifecycle_conformance
cd sdks/rust   && cargo test --features meta-proxy meta_proxy_lifecycle_conformance
```

The test uses a fake signed release channel, structured fake MetaHarness bridge,
foreign port process, virtual clock, hostile archives, crash-injecting
filesystem, and sentinel state. Canonical results must match across languages.
Stable promotion repeats install, start, readiness, auth, update/rollback,
owned stop, and uninstall with the real paired binaries and mock inference only,
verifying every artifact digest and zero real provider spend.

## References

- ADR-0019: agentic platform bounded contexts and SDK topology
- ADR-0020: agentic contract source of truth and code generation
- ADR-0021: agentic service configuration, transports, and capabilities
- ADR-0022: agentic authentication, tenant, budget, secret, and consent isolation
- ADR-0023: agentic errors, retries, idempotency, cancellation, and time budgets
- ADR-0025a: Meta Proxy client, routing, and consent
- ADR-0026a: OSS MetaHarness identity, structured bridge, and public SDK API
- ADR-0026b: MetaHarness process, filesystem, and npm/npx supply chain
- ADR-0028: agentic telemetry, usage, cost receipts, lineage, and redaction
- ADR-0029: language packaging, features, and CLI boundaries
- ADR-0030a: conformance, CI, and release evidence
- ADR-0030b: migration, rollout, and publication
- Meta Proxy ADR-304: local Meta LLM proxy and disclosure
- Meta Proxy ADR-307: runtime, packaging, and service lifecycle
- Meta Proxy ADR-322: scoped workload capabilities
