# Cognitum SDKs

Multi-language SDK ecosystem for the Cognitum chip simulator.

## Project Overview

This repo contains SDKs for interacting with the Cognitum massively parallel tile-based computing simulator. The primary package is `@ruv/cognitum-sdk` (TypeScript), with additional SDK stubs in Node.js (`@cognitum/sdk`), Python, and Rust under `sdks/`.

## Stack

- Language: TypeScript (primary)
- Build: tsup (CJS + ESM + type declarations)
- Test: vitest
- Key deps: RxJS (reactive event streaming)
- Node.js: >=18

## Build & Test

```bash
# From sdk-typescript/
npm install
npm run build          # tsup -> dist/ (CJS, ESM, .d.ts)
npm test               # vitest run
npm run test:coverage  # vitest run --coverage
npm run typecheck      # tsc --noEmit
npm run lint           # eslint src tests

# From sdks/node/
npm run build          # tsup
npm test               # vitest run
npm run typecheck      # tsc --noEmit
```

## Key Directories

- `sdk-typescript/` -- Primary SDK (`@ruv/cognitum-sdk`), RxJS-based, NAPI/WASM backends
- `sdk-typescript/src/` -- Core source: sdk.ts, stream.ts, events.ts, types.ts, backends/
- `sdks/node/` -- Lighter Node.js SDK (`@cognitum/sdk`) with CLI binary
- `sdks/python/` -- Python SDK (pyproject.toml)
- `sdks/rust/` -- Rust SDK (Cargo.toml)

## Architecture Notes

- `CognitumSDK.create()` is the main entry point; auto-detects NAPI vs WASM backend
- `ConfigBuilder` provides a fluent API for simulator configuration
- Event system uses RxJS Observables (`sdk.stream()`) and callback handlers (`sdk.on()`)
- Optional peer dependency on `@ruv/cognitum` for native NAPI performance
- Dual-format publishing: CJS (`dist/index.js`) + ESM (`dist/index.mjs`) + types
- Error hierarchy: CognitumError > ProgramError, ConfigurationError, BackendError, SimulationError

## Critical Rules

- NEVER commit secrets, credentials, or .env files
- ALWAYS run `npm test` after code changes
- ALWAYS verify `npm run build` succeeds before committing
- ALWAYS run `npm run typecheck` to catch type errors
- Keep files under 500 lines
- Use typed interfaces for all public APIs
- Validate input at system boundaries (see `validation.ts`)
