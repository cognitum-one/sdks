/**
 * Proxy authentication credentials (ADR-0025a §D6).
 *
 * Two variants exist in the contract: `LocalBearerToken` (the raw local proxy
 * bearer) and `WorkloadCapability` (a minted `mh1.<payload>.<hmac>` scoped
 * capability). This pass ships ONLY the local-bearer variant as constructable
 * — {@link LocalBearerTokenCredentialProvider}. The `WorkloadCapability`
 * variant is TYPE-ONLY: minting requires an injected `MetaProxyLifecycleProvider`
 * (ADR-0025b) and its MetaHarness-backed adapter (ADR-0026a), neither of which
 * exists in this codebase yet, so there is deliberately no constructor,
 * factory, or minting function for it here (ADR-0025a §D6: "The SDK may
 * validate non-secret claims but does not mint capabilities itself").
 *
 * The secret itself is never reinvented — a resolved credential rides the
 * existing ADR-0022 `Credential` / `RedactedSecret` contract from
 * `../agentic/index.js`, exactly like `StaticApiKeyCredentialProvider`.
 */

import { createHash } from "node:crypto";

import {
  AgenticError,
  RedactedSecret,
  type Credential,
  type CredentialAuthority,
  type CredentialProvider,
  type CredentialRequest,
} from "../agentic/index.js";
import type { WorkloadPolicy } from "./status.js";

const PRODUCT = "meta-proxy";

/**
 * Env var the local bearer is read from when no explicit `token` is passed —
 * mirrors `StaticApiKeyCredentialProvider`'s `COGNITUM_API_KEY` resolution
 * order (explicit arg, then env var, then fail at construction time).
 */
export const DEFAULT_META_PROXY_TOKEN_ENV_VAR = "COGNITUM_META_PROXY_TOKEN";

/**
 * The raw local proxy bearer (ADR-0025a §D6). Sent only to literal loopback
 * through a direct transport; never substituted with cloud, OAuth, sponsor,
 * or provider credentials.
 */
export interface LocalBearerToken {
  kind: "local_bearer_token";
  /** Resolved bearer, carried by the ADR-0022 `Credential` contract (scheme `"bearer"`). */
  credential: Credential;
}

/**
 * Non-secret claims of a workload capability (ADR-0025a §D6). The wire format
 * is `mh1.<payload>.<hmac>`, signed with the local proxy token, with an expiry
 * at most 12 hours ahead. The SDK may validate these claims but does not mint
 * the capability.
 */
export interface WorkloadCapabilityClaims {
  version: string;
  policy: WorkloadPolicy;
  worktreeId: string;
  /** ISO-8601 expiry; the contract caps this at 12 hours ahead of issuance. */
  expiresAt: string;
}

/**
 * A minted, scoped workload capability (ADR-0025a §D6). TYPE-ONLY in this
 * pass — see the module doc comment. There is no provider or factory that
 * produces one; that arrives with ADR-0025b's `MetaProxyLifecycleProvider`.
 */
export interface WorkloadCapability {
  kind: "workload_capability";
  claims: WorkloadCapabilityClaims;
  /** The `mh1.<payload>.<hmac>` value, carried by the ADR-0022 `Credential` contract. */
  credential: Credential;
}

/**
 * The two Proxy credential shapes (ADR-0025a §D6:
 * `ProxyCredential = LocalBearerToken | WorkloadCapability`). Only
 * `LocalBearerToken` is constructable this pass.
 */
export type ProxyCredential = LocalBearerToken | WorkloadCapability;

/** Construction-time options for {@link LocalBearerTokenCredentialProvider}. */
export interface LocalBearerTokenCredentialProviderOptions {
  /** Exact normalized (loopback) origin this provider is bound to (ADR-0022 §D3). */
  normalizedOrigin: string;
  /** Exact audience this provider is bound to; defaults to `normalizedOrigin`. */
  audience?: string;
  /**
   * Explicit local bearer token. When omitted, resolved from `envVar`
   * (default {@link DEFAULT_META_PROXY_TOKEN_ENV_VAR}), then fails at
   * construction time — same fail-closed order as
   * `StaticApiKeyCredentialProvider`.
   */
  token?: string;
  /** Override the environment variable name checked when `token` is omitted. */
  envVar?: string;
  /** Injectable environment map, for testing. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
}

function resolveToken(options: LocalBearerTokenCredentialProviderOptions): string {
  if (options.token && options.token.length > 0) {
    return options.token;
  }
  const envVar = options.envVar ?? DEFAULT_META_PROXY_TOKEN_ENV_VAR;
  const env = options.env ?? (typeof process !== "undefined" ? process.env : {});
  const fromEnv = env[envVar];
  if (fromEnv && fromEnv.length > 0) {
    return fromEnv;
  }
  throw new AgenticError(
    "configuration",
    `local proxy bearer is required — pass token or set ${envVar}`,
    { product: PRODUCT },
  );
}

/** Non-secret, non-reversible-in-practice fingerprint of a token value. */
function fingerprintOf(token: string): string {
  return createHash("sha256").update(`${PRODUCT}:${token}`).digest("hex").slice(0, 16);
}

/**
 * Concrete `CredentialProvider` for the raw local proxy bearer
 * (ADR-0025a §D6, ADR-0022 §D1/§D3). Fails closed on construction if no
 * token is available, and on any product / origin / audience mismatch at
 * acquire time — exact string equality only, no wildcard or DNS-parent
 * trust. Always hands out `scheme: "bearer"` so the client maps it to the
 * `Authorization` header.
 *
 * This models the `LocalBearerToken` half of `ProxyCredential`; the
 * `WorkloadCapability` half is not mintable in this pass (see module doc).
 */
export class LocalBearerTokenCredentialProvider implements CredentialProvider {
  readonly #secret: RedactedSecret;
  readonly #normalizedOrigin: string;
  readonly #audience: string;
  readonly #fingerprint: string;
  #invalidated = false;

  constructor(options: LocalBearerTokenCredentialProviderOptions) {
    const token = resolveToken(options);
    this.#secret = new RedactedSecret(token);
    this.#normalizedOrigin = options.normalizedOrigin;
    this.#audience = options.audience ?? options.normalizedOrigin;
    this.#fingerprint = fingerprintOf(token);
  }

  /** Non-secret stable provider identity, safe to log. */
  identity(): string {
    return `local-bearer-token:${PRODUCT}:${this.#fingerprint}`;
  }

  async describeAuthority(request: CredentialRequest): Promise<CredentialAuthority> {
    this.assertMatch(request);
    return this.authority();
  }

  async acquire(request: CredentialRequest): Promise<Credential> {
    this.assertMatch(request);
    if (this.#invalidated) {
      throw new AgenticError(
        "authentication",
        `credential provider ${this.identity()} has been invalidated`,
        { product: PRODUCT, operation: request.operation },
      );
    }
    return {
      scheme: "bearer",
      secret: this.#secret,
      audience: this.#audience,
      source: this.identity(),
      authority: this.authority(),
    };
  }

  async invalidate(_reason: string): Promise<void> {
    this.#invalidated = true;
  }

  private authority(): CredentialAuthority {
    return {
      providerFingerprint: this.#fingerprint,
      product: PRODUCT,
      normalizedOrigin: this.#normalizedOrigin,
      audience: this.#audience,
    };
  }

  /** Fail-closed match check (ADR-0022 §D1/§D3). Exact string equality only. */
  private assertMatch(request: CredentialRequest): void {
    if (request.product !== PRODUCT) {
      throw new AgenticError(
        "authentication",
        `credential provider ${this.identity()} is bound to product "${PRODUCT}", ` +
          `refusing request for product "${request.product}"`,
        { product: PRODUCT, operation: request.operation },
      );
    }
    if (request.normalizedOrigin !== this.#normalizedOrigin) {
      throw new AgenticError(
        "authentication",
        `credential provider ${this.identity()} is bound to origin ` +
          `"${this.#normalizedOrigin}", refusing request for origin ` +
          `"${request.normalizedOrigin}" (ADR-0022 §D3: a redirect to another ` +
          "origin is not followed with credentials)",
        { product: PRODUCT, operation: request.operation },
      );
    }
    if (request.audience !== this.#audience) {
      throw new AgenticError(
        "authentication",
        `credential provider ${this.identity()} is bound to audience ` +
          `"${this.#audience}", refusing request for audience "${request.audience}"`,
        { product: PRODUCT, operation: request.operation },
      );
    }
  }
}
