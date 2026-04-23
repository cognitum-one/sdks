# QE Audit & Strategy — Cognitum SDKs

Generated 2026-04-23 by the AQE fleet (hierarchical topology, QE queen coordinator) against v0.2.0 of `sdks/{node,python,rust}`.

## What's here

| File | Purpose |
|------|---------|
| [`security-audit.md`](security-audit.md) | SAST + targeted security review. 3 critical, 5 high, 6 medium, 6 low. |
| [`code-quality-audit.md`](code-quality-audit.md) | Parity drift, design smells, dead code. 3 blockers for the "aligned release" claim. |
| [`performance-audit.md`](performance-audit.md) | Hot-path review, allocation hotspots, benchmark gaps. 24 findings. |
| [`qx-sfdipot-analysis.md`](qx-sfdipot-analysis.md) | Developer experience + SFDIPOT product-factors + oracle problems. |
| [`test-strategy.md`](test-strategy.md) | Cross-SDK strategy for 0.3.0 cycle. 15 risks → 7 strategies → release gate. |
| [`test-plans.md`](test-plans.md) | Per-SDK test checklists (Node / Python / Rust) + shared contract fixtures. |
| [`exploratory-charters.md`](exploratory-charters.md) | Seven SBTM charters for 0.3.0. 90-minute timeboxed sessions, debrief required. |

## Headline findings

**Three criticals** (block 0.3.0 cut unless remediated or explicitly deferred with a tracking CVE):
1. Node TLS fingerprint pin uses `startsWith` without length floor → `fp=ab` matches 1/256 of any cert.
2. Python TLS pin has a TOCTOU — verify socket separate from request socket.
3. Python silent `CERT_NONE` fallback on `cognitum.local` and `169.254.*` (the default host).

**Three blockers for the "aligned release" claim in the 0.2.0 changelog:**
1. Python silently ignores `CallOptions.prefer` (zero routing effect).
2. Rust error taxonomy is 5+ variants short of ADR-0004 (encoded as magic-string prefixes).
3. `prefer=local-first` means different things in each SDK.

**Biggest DX bug:**
- Env-var resolution (`COGNITUM_API_KEY`, `COGNITUM_SEED_TOKEN`) is advertised in README and ADR-0007 but not read anywhere in Python or Rust production code. README overclaims 71 endpoints when 16 are implemented.

## Fleet used

- Fleet ID: `fleet-b1c3024b`
- Topology: hierarchical, 12 max agents
- Domains active: test-generation, coverage-analysis, quality-assessment, security-scanning, defect-prediction, performance-testing, requirements-validation, qx-analysis
- Spawned: 6 workers + 4 deep-analysis subagents (security, quality, performance, qx)
- Methodology: QCSD refinement phase (SFDIPOT + BDD + INVEST) blended with holistic-testing-PACT and context-driven testing principles.

## How to use this

1. Read `test-strategy.md` first — it names the risks and how they map to test categories.
2. If you're a maintainer of one SDK, read `test-plans.md` for your SDK's checklist.
3. If you're running an exploratory session this cycle, pick a charter from `exploratory-charters.md`.
4. If you're triaging the audit findings, prioritise by the risk table in `test-strategy.md` — the first three rows are TLS-related and should land in a 0.2.1 patch rather than waiting for 0.3.0.

## Regenerating

To refresh against a later SHA, re-run the AQE fleet:

```
npx aqe fleet init --topology hierarchical --max-agents 12
npx aqe code-index --target sdks/
# then spawn sub-agents via the QE queen coordinator per this template
```

The four sub-agent prompts are captured in conversation history; reproduce by re-running the security / code-quality / performance / qx audit subagents with the same prompts against the new SHA.
