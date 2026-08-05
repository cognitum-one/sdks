# Contributing

Thank you for improving the Cognitum SDKs. Node, Python, and Rust implement one shared public contract, so a local change may require cross-language evidence even when only one package changes.

## Before starting

1. Search existing issues and ADRs.
2. Open or reference an issue for behavior, contract, or public API changes.
3. Read the relevant ADR status and update date. ADRs are living plans; if the implementation changes an accepted decision, update the ADR in the same PR.
4. Do not add secrets, customer data, private endpoints, or runtime state such as `.swarm/`, databases, WAL files, or generated agent memory.

## Development

Run the gate for every package you change:

```bash
cd sdks/node
npm ci
npm run build
npm test
npm run typecheck
npm run lint
npm audit --audit-level=high

cd ../python
python -m pip install -e ".[dev]"
pytest
ruff check .
mypy

cd ../rust
FEATURES="native-tls,seed,stream,blocking,mdns,meta-llm,meta-proxy,metaharness,harnessaas"
cargo build --features "$FEATURES"
cargo test --features "$FEATURES"
cargo clippy --all-targets --features "$FEATURES" -- -D warnings

cd ../..
node --test scripts/tests/*.test.mjs
```

Do not substitute `--all-features`: it enables `live-seed-tests`. Live tests require explicit authorization and synthetic or dedicated test tenants/devices.

## Contract and test expectations

- Add one test per behavior with a descriptive name.
- Cover success, authentication/authorization failure, validation failure, timeout/cancellation, unknown fields/enums, redaction, and capability absence where applicable.
- Shared behavior belongs in `sdks/fixtures/` and must be driven by all applicable language adapters.
- Never weaken a coverage threshold to make a build pass.
- A new CI job must be included in `ga-gate.needs`, or it gates nothing.
- Examples and package exports must be tested against packed/installed artifacts, not only against the source tree.

## Pull requests

- Keep changes focused and explain user-visible impact.
- Link the issue and governing ADRs.
- State what was verified, with exact commands and environment.
- Identify assumptions, blocked registry/deployment work, and known limitations.
- Update README, changelog, capability manifest, and migration material when a public claim changes.
- Do not publish, tag, or deploy from a pull request.

By submitting a contribution, you agree that it is licensed under Apache-2.0 and that you have the right to submit it.
