/**
 * Concrete `CredentialProvider` for a delegated Cognitum OAuth access token
 * (ADR-0022 §D1, §D2, §D3; ADR-0024a §D8). Closes the gap left by PR #83's
 * `StaticApiKeyCredentialProvider`: ADR-0022 §D2's credential/header matrix
 * names Meta LLM as accepting "Product-declared `cog_` key OR a delegated
 * OAuth token" ("Never send both; route scope and auth method are
 * negotiated"), but until this provider, only the `cog_`-key half of that
 * row had an implementation.
 *
 * This provider does NOT implement an OAuth authorization-code/PKCE
 * browser login flow — that is out of scope here, exactly as
 * `StaticApiKeyCredentialProvider` accepts an already-resolved API key
 * rather than minting one. It accepts either:
 *
 * - an explicit, already-acquired access token (optionally with its own
 *   expiry/granted-scopes), or
 * - an injectable async `tokenProvider` callback the caller wires to their
 *   own OAuth refresh-token flow, invoked lazily on first `acquire()` and
 *   again — at most once per `acquire()` call — when the current token is
 *   expired.
 *
 * Wire scheme is `"Bearer"` (not `"X-API-Key"`), per ADR-0022 §D2's
 * "delegated OAuth token" row and ADR-0024a §D8's OAuth-uses-bearer
 * convention; `applyAuth` in `../meta-llm/nonstream.js` / `client.js`
 * already special-cases `scheme.toLowerCase() === "bearer"` to write the
 * standard `Authorization` header instead of a literal header named after
 * the scheme string, so this provider only has to supply that scheme name.
 *
 * Origin/audience/product binding mirrors
 * `StaticApiKeyCredentialProvider` exactly (ADR-0022 §D1/§D3): exact
 * string equality only, no wildcard origin or suffix matching. The
 * returned secret is wrapped in the same `RedactedSecret` type — Node
 * inspection, `JSON.stringify`, and error formatting MUST NOT reveal it.
 *
 * No HTTP request is made or shaped here — this type produces
 * credentials, it does not send them.
 */

import { createHash, randomBytes } from "node:crypto";

import {
  RedactedSecret,
  type Credential,
  type CredentialAuthority,
  type CredentialProvider,
  type CredentialRequest,
} from "./credentials.js";
import { AgenticError } from "./errors.js";

/** Result of an {@link OAuthTokenSource} invocation. */
export interface OAuthTokenSourceResult {
  accessToken: string;
  /** Absent means the token does not expire (or expiry is unknown to the caller). */
  expiresAt?: Date;
  /**
   * Scopes the identity service actually granted, if the caller's refresh
   * flow surfaces them. Left `undefined` (rather than guessed) when the
   * caller's OAuth flow doesn't expose this — ADR-0022 §D5 requires the
   * SDK never assume a broader-looking string implies permission.
   */
  grantedScopes?: string[];
}

/**
 * Caller-supplied async callback wired to an already-implemented OAuth
 * refresh-token flow. This provider calls it to obtain an initial token
 * (when no explicit `accessToken` is given) and to refresh an expired one
 * — it never performs the authorization-code/PKCE exchange itself.
 */
export type OAuthTokenSource = () => Promise<OAuthTokenSourceResult>;

/** Construction-time options for {@link OAuthTokenCredentialProvider}. */
export interface OAuthTokenCredentialProviderOptions {
  /** Product this provider is authoritative for (e.g. "meta-llm"). */
  product: string;
  /** Exact normalized origin this provider is bound to (ADR-0022 §D3). */
  normalizedOrigin: string;
  /** Exact audience this provider is bound to (ADR-0022 §D1). */
  audience: string;
  /**
   * An already-acquired OAuth access token. When omitted, `tokenProvider`
   * MUST be given — the provider fetches the initial token lazily, on the
   * first `acquire()` call, rather than at construction time.
   */
  accessToken?: string;
  /** Expiry of `accessToken`, if known. */
  expiresAt?: Date;
  /** Scopes granted to `accessToken`, if known (see {@link OAuthTokenSourceResult.grantedScopes}). */
  grantedScopes?: string[];
  /**
   * Injectable callback wired to the caller's own OAuth refresh-token
   * flow. Required when `accessToken` is omitted; optional (but
   * recommended) otherwise — supplying it lets an expired explicit token
   * be refreshed instead of failing closed.
   */
  tokenProvider?: OAuthTokenSource;
  /**
   * Wire scheme label surfaced on the acquired {@link Credential}.
   * Defaults to `"Bearer"` per ADR-0022 §D2 / ADR-0024a §D8 — OAuth
   * access tokens are never sent as `X-API-Key`.
   */
  scheme?: string;
}

interface ResolvedToken {
  accessToken: string;
  expiresAt?: Date;
  grantedScopes?: string[];
}

function isExpired(token: ResolvedToken, now: () => Date): boolean {
  return token.expiresAt !== undefined && token.expiresAt.getTime() <= now().getTime();
}

/** Non-secret, non-reversible-in-practice fingerprint of a token value. */
function fingerprintOfToken(product: string, token: string): string {
  return createHash("sha256").update(`${product}:${token}`).digest("hex").slice(0, 16);
}

/** Non-secret per-instance fingerprint used when no token is known yet at construction. */
function fingerprintOfPending(product: string): string {
  return createHash("sha256")
    .update(`${product}:oauth-pending:${randomBytes(16).toString("hex")}`)
    .digest("hex")
    .slice(0, 16);
}

/**
 * Concrete `CredentialProvider` wrapping one delegated Cognitum OAuth
 * access token (ADR-0022 §D1/§D2/§D3, ADR-0024a §D8). Fails closed on any
 * product, origin, or audience mismatch (mirrors
 * `StaticApiKeyCredentialProvider#assertMatch`), on an expired token with
 * no refresh callback, and on any use after `invalidate()`.
 */
export class OAuthTokenCredentialProvider implements CredentialProvider {
  readonly #product: string;
  readonly #normalizedOrigin: string;
  readonly #audience: string;
  readonly #scheme: string;
  readonly #tokenProvider?: OAuthTokenSource;
  readonly #now: () => Date;
  #current?: ResolvedToken;
  #fingerprint: string;
  #invalidated = false;

  constructor(options: OAuthTokenCredentialProviderOptions, now: () => Date = () => new Date()) {
    if (!options.accessToken && !options.tokenProvider) {
      throw new AgenticError(
        "configuration",
        "OAuthTokenCredentialProvider requires either an explicit accessToken or a tokenProvider callback",
        { product: options.product },
      );
    }
    this.#product = options.product;
    this.#normalizedOrigin = options.normalizedOrigin;
    this.#audience = options.audience;
    this.#scheme = options.scheme ?? "Bearer";
    this.#tokenProvider = options.tokenProvider;
    this.#now = now;

    if (options.accessToken) {
      this.#current = {
        accessToken: options.accessToken,
        expiresAt: options.expiresAt,
        grantedScopes: options.grantedScopes,
      };
      this.#fingerprint = fingerprintOfToken(options.product, options.accessToken);
    } else {
      // No token is known yet — the first `acquire()` call fetches one
      // from `tokenProvider`. `identity()` still needs a stable,
      // non-secret value before that happens.
      this.#fingerprint = fingerprintOfPending(options.product);
    }
  }

  /** Non-secret stable provider identity, safe to log. */
  identity(): string {
    return `oauth-token:${this.#product}:${this.#fingerprint}`;
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
        { product: this.#product, operation: request.operation },
      );
    }

    let token = this.#current;
    if (token === undefined || isExpired(token, this.#now)) {
      if (!this.#tokenProvider) {
        throw new AgenticError(
          "authentication",
          `credential provider ${this.identity()} has no valid access token ` +
            "(expired and no tokenProvider callback was configured to refresh it)",
          { product: this.#product, operation: request.operation },
        );
      }
      const refreshed = await this.#tokenProvider();
      token = {
        accessToken: refreshed.accessToken,
        expiresAt: refreshed.expiresAt,
        grantedScopes: refreshed.grantedScopes,
      };
      if (isExpired(token, this.#now)) {
        throw new AgenticError(
          "authentication",
          `credential provider ${this.identity()}'s tokenProvider returned an already-expired access token`,
          { product: this.#product, operation: request.operation },
        );
      }
      this.#current = token;
      this.#fingerprint = fingerprintOfToken(this.#product, token.accessToken);
    }

    return {
      scheme: this.#scheme,
      secret: new RedactedSecret(token.accessToken),
      expiresAt: token.expiresAt?.toISOString(),
      grantedScopes: token.grantedScopes,
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
      product: this.#product,
      normalizedOrigin: this.#normalizedOrigin,
      audience: this.#audience,
      effectiveScopes: this.#current?.grantedScopes,
    };
  }

  /**
   * Fail-closed match check (ADR-0022 §D1/§D3). Exact string equality
   * only — no wildcard origin, suffix matching, or DNS-parent trust.
   */
  private assertMatch(request: CredentialRequest): void {
    if (request.product !== this.#product) {
      throw new AgenticError(
        "authentication",
        `credential provider ${this.identity()} is bound to product ` +
          `"${this.#product}", refusing request for product ` +
          `"${request.product}"`,
        { product: this.#product, operation: request.operation },
      );
    }
    if (request.normalizedOrigin !== this.#normalizedOrigin) {
      throw new AgenticError(
        "authentication",
        `credential provider ${this.identity()} is bound to origin ` +
          `"${this.#normalizedOrigin}", refusing request for origin ` +
          `"${request.normalizedOrigin}" (ADR-0022 §D3: a redirect to ` +
          "another origin is not followed with credentials)",
        { product: this.#product, operation: request.operation },
      );
    }
    if (request.audience !== this.#audience) {
      throw new AgenticError(
        "authentication",
        `credential provider ${this.identity()} is bound to audience ` +
          `"${this.#audience}", refusing request for audience ` +
          `"${request.audience}"`,
        { product: this.#product, operation: request.operation },
      );
    }
  }
}
