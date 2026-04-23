/**
 * Per-peer pairing-token store (ADR-0016a §D5).
 *
 * Seed pairing is per-device: `DELETE /api/v1/pair/{client_name}` deletes
 * one client on one seed, so an SDK talking to N peers needs N potentially
 * distinct tokens. The {@link TokenBook} interface lets callers plug in
 * their own storage (OS keychain, encrypted file, test fixture); the
 * default {@link InMemoryTokenBook} holds tokens in a `Map` and wraps
 * every value in {@link SecretString} so `console.log` / `util.inspect`
 * never leaks the raw token.
 *
 * Mirror of `sdks/rust/src/seed/token_book.rs`.
 */

import { normaliseBaseUrl } from "./peers.js";

/**
 * Opaque pairing-token wrapper.
 *
 * The wire value is only exposed via {@link SecretString.reveal}. `toString`,
 * `toJSON`, and the custom `util.inspect` hook return `<redacted>` so the
 * token never appears in logs, stack traces, or serialised objects.
 */
export class SecretString {
  readonly #value: string;

  constructor(value: string) {
    if (typeof value !== "string") {
      throw new TypeError("SecretString: value must be a string");
    }
    this.#value = value;
  }

  /**
   * Borrow the inner token. Use sparingly — never log the result.
   */
  reveal(): string {
    return this.#value;
  }

  /** Whether the underlying string is empty. */
  isEmpty(): boolean {
    return this.#value.length === 0;
  }

  /** Length of the underlying string (exposed for diagnostics). */
  get length(): number {
    return this.#value.length;
  }

  toString(): string {
    return `SecretString(<redacted, ${this.#value.length} bytes>)`;
  }

  toJSON(): string {
    return "<redacted>";
  }

  /** Node.js `util.inspect` hook so `console.log` prints a redacted form. */
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return this.toString();
  }
}

/**
 * Peer-keyed pairing-token store. Implementations MUST key on a normalised
 * peer URL (use {@link normaliseBaseUrl} from `peers.ts`). All methods
 * are synchronous — callers that need async storage should wrap a
 * cached-on-read abstraction around this interface.
 */
export interface TokenBook {
  /**
   * Look up the token for `peerUrl`. Returns `undefined` when no pairing
   * exists for that peer (the call will either surface `AuthError` or
   * proceed unauthenticated against WiFi-read endpoints).
   */
  get(peerUrl: string): SecretString | undefined;
  /**
   * Store `token` under `peerUrl`. Overwrites any previous value.
   */
  set(peerUrl: string, token: SecretString): void;
  /**
   * Forget the token for `peerUrl`. Idempotent — safe to call when the
   * peer has no entry.
   */
  delete(peerUrl: string): void;
}

/**
 * Default in-memory implementation. Not persisted; tokens vanish when
 * the owning {@link SeedClient} is garbage-collected.
 */
export class InMemoryTokenBook implements TokenBook {
  readonly #inner: Map<string, SecretString> = new Map();

  /**
   * Build a book from an iterable of `[peerUrl, token]` pairs. Raw
   * strings are promoted to {@link SecretString} automatically.
   */
  static fromEntries(
    entries: Iterable<readonly [string, string | SecretString]>,
  ): InMemoryTokenBook {
    const book = new InMemoryTokenBook();
    for (const [url, token] of entries) {
      book.set(
        url,
        typeof token === "string" ? new SecretString(token) : token,
      );
    }
    return book;
  }

  get(peerUrl: string): SecretString | undefined {
    return this.#inner.get(normalise(peerUrl));
  }

  set(peerUrl: string, token: SecretString): void {
    this.#inner.set(normalise(peerUrl), token);
  }

  delete(peerUrl: string): void {
    this.#inner.delete(normalise(peerUrl));
  }

  /** Number of entries; exposed for tests and introspection. */
  get size(): number {
    return this.#inner.size;
  }
}

function normalise(peerUrl: string): string {
  // The caller-supplied URL has already been normalised by `PeerSet` when
  // the token is looked up by the request path; accept either a full URL
  // or a raw trim-only key to keep test fixtures terse.
  try {
    return normaliseBaseUrl(peerUrl);
  } catch {
    return peerUrl.replace(/\/+$/, "");
  }
}

/**
 * Pair `clientName` against every peer referenced by `book`, using the
 * caller-supplied `pair` helper. The helper is expected to call
 * `POST /api/v1/pair` against one specific peer and return the response
 * body; this shape keeps `tokenBook.ts` free of HTTP concerns while still
 * giving callers a one-shot mesh-pairing convenience.
 *
 * Returns the list of `[peerUrl, response]` pairs in iteration order.
 * Errors from the `pair` helper propagate — callers decide whether to
 * retry individual peers.
 *
 * Mirrors the `pair_all` helper proposed in ADR-0016a §D5.
 */
export async function pairAll<R extends { token?: string; pairing_token?: string }>(
  peers: readonly string[],
  clientName: string,
  pair: (peerUrl: string, clientName: string) => Promise<R>,
  book?: TokenBook,
): Promise<Array<readonly [string, R]>> {
  if (!clientName || typeof clientName !== "string") {
    throw new TypeError("pairAll: clientName must be a non-empty string");
  }
  if (!Array.isArray(peers) || peers.length === 0) {
    throw new TypeError("pairAll: at least one peer required");
  }
  const results: Array<readonly [string, R]> = [];
  for (const peer of peers) {
    const response = await pair(peer, clientName);
    const raw = response.pairing_token ?? response.token;
    if (book && typeof raw === "string" && raw.length > 0) {
      book.set(peer, new SecretString(raw));
    }
    results.push([peer, response] as const);
  }
  return results;
}
