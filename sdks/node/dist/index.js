// src/errors.ts
var CognitumError = class extends Error {
  /** Machine-readable error code. */
  code;
  /** HTTP status code, if applicable. */
  statusCode;
  constructor(message, code, statusCode) {
    super(message);
    this.name = "CognitumError";
    this.code = code;
    this.statusCode = statusCode;
    Object.setPrototypeOf(this, new.target.prototype);
  }
};
var AuthError = class extends CognitumError {
  constructor(message = "Authentication failed") {
    super(message, "AUTH_ERROR", 401);
    this.name = "AuthError";
  }
};
var RateLimitError = class extends CognitumError {
  /** Milliseconds to wait before retrying, parsed from Retry-After header. */
  retryAfterMs;
  constructor(retryAfterMs = 1e3, message = "Rate limit exceeded") {
    super(message, "RATE_LIMIT", 429);
    this.name = "RateLimitError";
    this.retryAfterMs = retryAfterMs;
  }
};
var ValidationError = class extends CognitumError {
  constructor(message = "Validation failed") {
    super(message, "VALIDATION_ERROR", 400);
    this.name = "ValidationError";
  }
};
var NotFoundError = class extends CognitumError {
  constructor(message = "Resource not found") {
    super(message, "NOT_FOUND", 404);
    this.name = "NotFoundError";
  }
};

// src/client.ts
var DEFAULT_BASE_URL = "https://api.cognitum.one";
var DEFAULT_TIMEOUT = 3e4;
var DEFAULT_RETRIES = 3;
var BASE_MS = 500;
var CAP_MS = 3e4;
var DEFAULT_MAX_ELAPSED_MS = 6e4;
var RETRIABLE_STATUS = /* @__PURE__ */ new Set([429, 500, 502, 503, 504]);
var HttpClient = class {
  apiKey;
  baseUrl;
  timeout;
  retries;
  rateLimitRetry;
  maxElapsedMs;
  constructor(config) {
    const resolved = resolveApiKey(config.apiKey);
    this.apiKey = resolved;
    const rawBaseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
    let end = rawBaseUrl.length;
    while (end > 0 && rawBaseUrl.charCodeAt(end - 1) === 47) end--;
    this.baseUrl = rawBaseUrl.slice(0, end);
    this.timeout = config.timeout ?? DEFAULT_TIMEOUT;
    this.retries = config.retries ?? DEFAULT_RETRIES;
    this.rateLimitRetry = config.rateLimitRetry ?? true;
    this.maxElapsedMs = config.maxElapsedMs ?? DEFAULT_MAX_ELAPSED_MS;
  }
  /**
   * Perform an HTTP request against the Cognitum API.
   *
   * Automatically injects the API key header, serialises JSON bodies,
   * retries on transient errors with equal-jitter back-off per ADR-0005,
   * and maps HTTP error responses to typed SDK errors.
   */
  async request(method, path, body, opts) {
    const url = `${this.baseUrl}${path}`;
    const headers = {
      "X-API-Key": this.apiKey,
      Accept: "application/json"
    };
    const init = { method, headers };
    if (body !== void 0) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    const methodUpper = method.toUpperCase();
    const idempotent = opts?.idempotent ?? methodUpper !== "POST";
    const started = Date.now();
    let lastError;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeout);
      init.signal = controller.signal;
      try {
        const response = await fetch(url, init);
        clearTimeout(timer);
        if (response.ok) {
          if (response.status === 204) {
            return void 0;
          }
          return await response.json();
        }
        const errorBody = await response.text().catch(() => "");
        const errorMessage = tryParseErrorMessage(errorBody) ?? response.statusText;
        switch (response.status) {
          case 401:
          case 403:
            throw new AuthError(errorMessage);
          case 404:
            throw new NotFoundError(errorMessage);
          case 400:
          case 422:
            throw new ValidationError(errorMessage);
          case 429: {
            const retryAfterMs = resolveRetryAfter(response, errorBody);
            const err = new RateLimitError(retryAfterMs, errorMessage);
            if (!this.rateLimitRetry || !canRetry(attempt, this.retries, started, this.maxElapsedMs)) {
              throw err;
            }
            lastError = err;
            await sleep(
              clampToBudget(retryAfterMs, started, this.maxElapsedMs)
            );
            continue;
          }
          default:
            if (RETRIABLE_STATUS.has(response.status) && idempotent && canRetry(attempt, this.retries, started, this.maxElapsedMs)) {
              lastError = new CognitumError(
                errorMessage,
                "SERVER_ERROR",
                response.status
              );
              await sleep(
                clampToBudget(
                  equalJitterBackoff(attempt),
                  started,
                  this.maxElapsedMs
                )
              );
              continue;
            }
            throw new CognitumError(
              errorMessage,
              "SERVER_ERROR",
              response.status
            );
        }
      } catch (error) {
        clearTimeout(timer);
        if (error instanceof AuthError || error instanceof NotFoundError || error instanceof ValidationError) {
          throw error;
        }
        if (error instanceof RateLimitError) {
          throw error;
        }
        if (error instanceof CognitumError && error.code === "SERVER_ERROR") {
          throw error;
        }
        if (error instanceof DOMException && error.name === "AbortError") {
          lastError = new CognitumError("Request timed out", "TIMEOUT");
          if (idempotent && canRetry(attempt, this.retries, started, this.maxElapsedMs)) {
            await sleep(
              clampToBudget(
                equalJitterBackoff(attempt),
                started,
                this.maxElapsedMs
              )
            );
            continue;
          }
          throw lastError;
        }
        if (canRetry(attempt, this.retries, started, this.maxElapsedMs)) {
          lastError = error instanceof Error ? error : new Error(String(error));
          await sleep(
            clampToBudget(
              equalJitterBackoff(attempt),
              started,
              this.maxElapsedMs
            )
          );
          continue;
        }
        if (error instanceof CognitumError) {
          throw error;
        }
        throw new CognitumError(
          error instanceof Error ? error.message : String(error),
          "NETWORK_ERROR"
        );
      }
    }
    throw lastError ?? new CognitumError("Request failed", "UNKNOWN");
  }
};
function resolveApiKey(explicit) {
  if (explicit && explicit.length > 0) return explicit;
  const fromEnv = typeof process !== "undefined" ? process.env?.COGNITUM_API_KEY : void 0;
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  throw new AuthError(
    "apiKey is required \u2014 pass config.apiKey or set COGNITUM_API_KEY"
  );
}
function equalJitterBackoff(attempt) {
  const expo = BASE_MS * 2 ** attempt;
  const jitter = Math.random() * BASE_MS;
  return Math.min(CAP_MS, expo + jitter);
}
function canRetry(attempt, retries, startedAt, maxElapsedMs) {
  if (attempt >= retries) return false;
  return Date.now() - startedAt < maxElapsedMs;
}
function clampToBudget(delayMs, startedAt, maxElapsedMs) {
  const remaining = maxElapsedMs - (Date.now() - startedAt);
  if (remaining <= 0) return 0;
  return Math.max(0, Math.min(delayMs, remaining));
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function resolveRetryAfter(response, body) {
  const fromBody = parseRetryAfterBody(body);
  if (fromBody !== void 0) return fromBody;
  const fromHeader = parseRetryAfterHeader(
    response.headers.get("Retry-After")
  );
  if (fromHeader !== void 0) return fromHeader;
  return 1e3;
}
function parseRetryAfterHeader(h) {
  if (!h) return void 0;
  const seconds = Number(h);
  if (!Number.isNaN(seconds) && seconds >= 0) {
    return Math.round(seconds * 1e3);
  }
  const date = Date.parse(h);
  if (!Number.isNaN(date)) {
    return Math.max(date - Date.now(), 0);
  }
  return void 0;
}
function parseRetryAfterBody(body) {
  if (!body) return void 0;
  try {
    const parsed = JSON.parse(body);
    if (parsed && typeof parsed === "object") {
      if (typeof parsed.retry_after_us === "number") {
        return Math.round(parsed.retry_after_us / 1e3);
      }
      const hints = [parsed.error, parsed.message];
      for (const h of hints) {
        if (typeof h === "string") {
          const n = extractRetryAfterSeconds(h);
          if (n !== void 0) return n;
        }
      }
    }
  } catch {
  }
  return extractRetryAfterSeconds(body);
}
function extractRetryAfterSeconds(text) {
  const m = /retry after (\d+(?:\.\d+)?)\s*s/i.exec(text);
  if (!m) return void 0;
  const seconds = Number(m[1]);
  if (Number.isNaN(seconds) || seconds < 0) return void 0;
  return Math.round(seconds * 1e3);
}
function tryParseErrorMessage(body) {
  if (!body) return void 0;
  try {
    const parsed = JSON.parse(body);
    if (typeof parsed.message === "string") return parsed.message;
    if (typeof parsed.error === "string") return parsed.error;
  } catch {
  }
  return void 0;
}

// src/catalog.ts
var CatalogResource = class {
  constructor(client) {
    this.client = client;
  }
  client;
  /** Browse available products, optionally filtered by category. */
  async browse(options) {
    const params = new URLSearchParams();
    if (options?.category) {
      params.set("category", options.category);
    }
    const query = params.toString();
    const path = `/apiCatalog${query ? `?${query}` : ""}`;
    return this.client.request("GET", path);
  }
};

// src/orders.ts
var OrdersResource = class {
  constructor(client) {
    this.client = client;
  }
  client;
  /** Look up the status of an existing order by email. */
  async status(email) {
    const params = new URLSearchParams({ email });
    return this.client.request("GET", `/lookupOrderStatus?${params}`);
  }
  /** Create a new presale order, returning a Stripe client secret for payment. */
  async create(params) {
    return this.client.request(
      "POST",
      "/createPresalePaymentIntent",
      params
    );
  }
};

// src/leads.ts
var LeadsResource = class {
  constructor(client) {
    this.client = client;
  }
  client;
  /** Subscribe an email to the notify-me / waitlist list. */
  async subscribe(params) {
    await this.client.request("POST", "/saveNotifyLead", params);
  }
};

// src/contact.ts
var ContactResource = class {
  constructor(client) {
    this.client = client;
  }
  client;
  /** Send a contact message. Triggers an email to the Cognitum team. */
  async send(params) {
    await this.client.request("POST", "/sendContactEmail", params);
  }
};

// src/devices.ts
var DevicesResource = class {
  constructor(client) {
    this.client = client;
  }
  client;
  /** Register a new device with its Ed25519 public key. */
  async register(params) {
    await this.client.request("POST", "/seedRegisterDevice", params);
  }
  /** Check if a firmware update is available for the given device. */
  async checkUpdate(deviceId) {
    const params = new URLSearchParams({ deviceId });
    return this.client.request(
      "GET",
      `/seedCheckUpdate?${params}`
    );
  }
  /** Send a device heartbeat / health check. */
  async heartbeat(deviceId) {
    await this.client.request("POST", "/seedHeartbeat", { device_id: deviceId });
  }
};

// src/mcp.ts
var McpResource = class {
  constructor(client) {
    this.client = client;
  }
  client;
  /** List all available MCP tools. */
  async listTools() {
    return this.client.request("GET", "/apiMcpTools");
  }
  /**
   * Call an MCP tool by name with the given arguments.
   * Uses JSON-RPC format over the SSE endpoint.
   */
  async callTool(name, args = {}) {
    return this.client.request("POST", "/mcpSse", {
      jsonrpc: "2.0",
      id: crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`,
      method: "tools/call",
      params: { name, arguments: args }
    });
  }
  /** Search the documentation knowledge base. */
  async searchDocs(query, limit = 5) {
    const result = await this.callTool("docs_search", { query, limit });
    const content = result?.result?.content ?? result?.content ?? [];
    const textContent = Array.isArray(content) ? content.find((c) => c.type === "text") : void 0;
    if (textContent?.text) {
      try {
        return JSON.parse(textContent.text);
      } catch {
        return [];
      }
    }
    return [];
  }
};

// src/brain.ts
var BrainResource = class {
  constructor(client) {
    this.client = client;
  }
  client;
  /** Share a new memory / knowledge entry. */
  async share(params) {
    return this.client.request("POST", "/brain/share", params);
  }
  /** Search the shared brain knowledge base. */
  async search(query, options) {
    const params = { query };
    if (options?.limit) params.limit = options.limit;
    if (options?.tags) params.tags = options.tags;
    return this.client.request(
      "POST",
      "/brain/search",
      params
    );
  }
  /** Vote on a brain memory entry (upvote / downvote). */
  async vote(memoryId, direction) {
    await this.client.request("POST", "/brain/vote", {
      memoryId,
      direction
    });
  }
};

// src/index.ts
var Cognitum = class {
  /** Browse the product / template catalog. */
  catalog;
  /** Create and look up orders. */
  orders;
  /** Subscribe leads to the waitlist. */
  leads;
  /** Send contact-form messages. */
  contact;
  /** Manage OTA devices. */
  devices;
  /** Interact with the MCP tool server. */
  mcp;
  /** Shared knowledge / brain system. */
  brain;
  client;
  constructor(config) {
    this.client = new HttpClient(config);
    this.catalog = new CatalogResource(this.client);
    this.orders = new OrdersResource(this.client);
    this.leads = new LeadsResource(this.client);
    this.contact = new ContactResource(this.client);
    this.devices = new DevicesResource(this.client);
    this.mcp = new McpResource(this.client);
    this.brain = new BrainResource(this.client);
  }
  /** Check the API health status. */
  async health() {
    return this.client.request("GET", "/health");
  }
};
export {
  AuthError,
  BrainResource,
  CatalogResource,
  Cognitum,
  CognitumError,
  ContactResource,
  DevicesResource,
  HttpClient,
  LeadsResource,
  McpResource,
  NotFoundError,
  OrdersResource,
  RateLimitError,
  ValidationError
};
//# sourceMappingURL=index.js.map