/**
 * HTTP-status -> `AgenticErrorKind` mapping for MetaProxyClient
 * (ADR-0025a §D8's error table is deferred; this pass reuses the same
 * ADR-0024a §D6 status table `MetaLlmClient` uses — `../meta-llm/http-errors.js`
 * — since none of these statuses are Proxy-specific and D8's Proxy-specific
 * `MetaProxyError` shape (`configuredPlane`/`selectedPlane`/`upstreamStatus`
 * fields) is explicitly out of scope this pass).
 */

import { AgenticError } from "../agentic/index.js";

const PRODUCT = "meta-proxy";

function nonEmpty(value: string, fallback: string): string {
  return value.length > 0 ? value : fallback;
}

/** Minimal response shape this mapper needs — satisfied by `fetch`'s `Response`. */
export interface HttpErrorResponse {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export async function mapMetaProxyHttpError(
  response: HttpErrorResponse,
  operation: string,
  requestId: string,
): Promise<AgenticError> {
  const status = response.status;
  const bodyText = await response.text().catch(() => "");
  const fields = { product: PRODUCT, operation, status, requestId };

  switch (status) {
    case 400:
      return new AgenticError("validation", nonEmpty(bodyText, "invalid request"), {
        ...fields,
        retryable: false,
      });
    case 401:
      return new AgenticError(
        "authentication",
        nonEmpty(bodyText, "local Proxy authentication failed"),
        { ...fields, retryable: false },
      );
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
