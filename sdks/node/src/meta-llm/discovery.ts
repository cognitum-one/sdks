/**
 * Discovery wire types: health, models, whoami (ADR-0024a §D1, §D2).
 *
 * No service-owned OpenAPI contract exists yet (ADR-0024a §D9 gate #1), so
 * these stay intentionally permissive (`raw` passthrough) rather than
 * pretending to be the eventual GA contract.
 */

/** `health()` response — process-level only, never identity or readiness. */
export interface MetaLlmHealth {
  status: string;
  version?: string;
  /** Unrecognized fields from the server response, preserved verbatim. */
  raw?: Record<string, unknown>;
}

/** A single entry from `models()`. `/v1/models` may not list every accepted alias. */
export interface MetaLlmModelInfo {
  id: string;
  object?: string;
  ownedBy?: string;
  created?: number;
  raw?: Record<string, unknown>;
}

/** `models()` response. */
export interface MetaLlmModelList {
  object?: string;
  models: MetaLlmModelInfo[];
  raw?: Record<string, unknown>;
}

/** `whoami()` response — authenticated account and credential type only. */
export interface MetaLlmWhoAmI {
  accountId?: string;
  credentialType?: string;
  scopes?: string[];
  tenantId?: string;
  raw?: Record<string, unknown>;
}
