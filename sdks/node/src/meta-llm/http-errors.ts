/**
 * HTTP-status -> `AgenticErrorKind` mapping (ADR-0024a §D6's full table).
 * Shared by every operation's error path — GET (`health`/`whoami`/
 * `models`, in `./client.js`) and the idempotent-with-key POSTs
 * (`./nonstream.js`) alike, since none of these statuses are
 * protocol-specific.
 */

import { AgenticError } from "../agentic/index.js";

const PRODUCT = "meta-llm";

function nonEmpty(value: string, fallback: string): string {
  return value.length > 0 ? value : fallback;
}

/** Minimal response shape this mapper needs — satisfied by `fetch`'s `Response`. */
export interface HttpErrorResponse {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export async function mapMetaLlmHttpError(
  response: HttpErrorResponse,
  operation: string,
  requestId: string,
): Promise<AgenticError> {
  const status = response.status;
  const bodyText = await response.text().catch(() => "");
  const fields = { product: PRODUCT, operation, status, requestId };

  switch (status) {
    // Never retried (ADR-0024a §D6).
    case 400:
      return new AgenticError("validation", nonEmpty(bodyText, "invalid request"), {
        ...fields,
        retryable: false,
      });
    case 401:
      return new AgenticError("authentication", nonEmpty(bodyText, "authentication failed"), {
        ...fields,
        retryable: false,
      });
    case 403:
      return new AgenticError("permission_denied", nonEmpty(bodyText, "permission denied"), {
        ...fields,
        retryable: false,
      });
    case 404:
      return new AgenticError("not_found", nonEmpty(bodyText, "not found"), {
        ...fields,
        retryable: false,
      });
    case 409:
      return new AgenticError(
        "conflict",
        nonEmpty(bodyText, "state conflict or idempotency mismatch"),
        { ...fields, retryable: false },
      );
    case 402:
      return new AgenticError(
        "budget_exceeded",
        nonEmpty(bodyText, "budget or upgrade required"),
        { ...fields, retryable: false },
      );
    case 422:
      return new AgenticError(
        "safety_blocked",
        nonEmpty(bodyText, "safety or semantic validation failed"),
        { ...fields, retryable: false },
      );
    // Bounded retry only when the caller proves replay safety (an
    // idempotent-with-key operation) — the retry loop in `./nonstream.js`
    // is what actually gates this; `retryable: true` here only reflects
    // the status's own classification.
    case 429: {
      const retryAfterHeader = response.headers.get("retry-after");
      const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : undefined;
      return new AgenticError("rate_limited", nonEmpty(bodyText, "rate limited"), {
        ...fields,
        retryable: true,
        retryAfterMs,
      });
    }
    case 502:
    case 503:
      return new AgenticError("transport", nonEmpty(bodyText, `upstream error ${status}`), {
        ...fields,
        retryable: true,
      });
    default:
      return new AgenticError("protocol", nonEmpty(bodyText, `unexpected status ${status}`), {
        ...fields,
        retryable: false,
      });
  }
}
