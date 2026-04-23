/**
 * Seed-side re-exports of the cross-SDK error taxonomy (ADR-0004).
 *
 * The seed client does not define its own error hierarchy — it uses the
 * shared one in `src/errors.ts`. This barrel file exists so that seed
 * internals can `import { ... } from "./errors.js"` without reaching
 * outside `src/seed/`.
 */

export {
  CognitumError,
  AuthError,
  RateLimitError,
  ValidationError,
  NotFoundError,
  ConflictError,
  NotImplementedError,
  ServiceUnavailableError,
  NetworkError,
  TimeoutError,
  ParseError,
  ConfigError,
  TlsPinError,
  TrustScoreBlockedError,
} from "../errors.js";
