/** Configuration for the Cognitum SDK client. */
interface CognitumConfig {
    /** API key for authenticating requests. */
    apiKey: string;
    /** Base URL for the Cognitum API. Defaults to the production Cloud Functions URL. */
    baseUrl?: string;
    /** Request timeout in milliseconds. Defaults to 30000. */
    timeout?: number;
    /** Number of retry attempts for transient failures. Defaults to 3. */
    retries?: number;
    /** Whether to automatically retry on 429 rate limit responses. Defaults to true. */
    rateLimitRetry?: boolean;
    /**
     * Total wall-clock budget across all retry attempts, in milliseconds.
     * Defaults to 60_000 per ADR-0005. The retry loop breaks early if
     * `Date.now() - start >= maxElapsedMs`.
     */
    maxElapsedMs?: number;
}
interface Product {
    id: string;
    name: string;
    description: string;
    category: string;
    price: number;
    currency: string;
    imageUrl?: string;
    available: boolean;
    metadata?: Record<string, unknown>;
}
interface CatalogResponse {
    products: Product[];
    total: number;
}
interface Order {
    id: string;
    status: "pending" | "confirmed" | "shipped" | "delivered" | "cancelled" | "refunded";
    email: string;
    amount: number;
    currency: string;
    createdAt: string;
    updatedAt: string;
    shippingAddress?: ShippingAddress;
    metadata?: Record<string, unknown>;
}
interface ShippingAddress {
    name: string;
    line1: string;
    line2?: string;
    city: string;
    state: string;
    postalCode: string;
    country: string;
}
interface OrderCreateParams {
    email: string;
    name: string;
    shippingAddress?: ShippingAddress;
    metadata?: Record<string, unknown>;
}
interface OrderCreateResponse {
    orderId: string;
    clientSecret: string;
    amount: number;
    currency: string;
}
interface LeadSubscribeParams {
    email: string;
    source?: string;
    metadata?: Record<string, unknown>;
}
interface ContactSendParams {
    name: string;
    email: string;
    message: string;
    subject?: string;
}
interface McpTool {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
}
interface McpToolCallResult {
    content: Array<{
        type: string;
        text?: string;
        data?: unknown;
    }>;
    isError?: boolean;
    /** Nested result when the server wraps the response. */
    result?: {
        content: Array<{
            type: string;
            text?: string;
            data?: unknown;
        }>;
        isError?: boolean;
    };
}
interface DeviceRegisterParams {
    deviceId: string;
    publicKey: string;
    model?: string;
    firmwareVersion?: string;
}
interface DeviceUpdateCheck {
    updateAvailable: boolean;
    currentVersion: string;
    latestVersion?: string;
    downloadUrl?: string;
    releaseNotes?: string;
    size?: number;
}
interface Device {
    deviceId: string;
    model: string;
    firmwareVersion: string;
    lastSeen: string;
    status: "online" | "offline" | "updating";
}
interface FleetStatus {
    totalDevices: number;
    onlineDevices: number;
    updatingDevices: number;
    devices: Device[];
}
interface HealthResponse {
    status: "ok" | "degraded" | "down";
    version?: string;
    timestamp: string;
}
interface SearchResult {
    title: string;
    content: string;
    url?: string;
    score: number;
    metadata?: Record<string, unknown>;
}
interface BrainShareParams {
    title: string;
    content: string;
    tags?: string[];
    visibility?: "public" | "private";
}
interface BrainMemory {
    id: string;
    title: string;
    content: string;
    tags: string[];
    visibility: "public" | "private";
    votes: number;
    createdAt: string;
}
interface BrainSearchResult {
    memories: BrainMemory[];
    total: number;
}

/** Optional per-request options. */
interface RequestOpts {
    /**
     * Whether retrying this request after a read / total timeout is safe.
     *
     * Defaults:
     * - GET / HEAD / OPTIONS / PUT / DELETE: `true`
     * - POST: `false` (POSTs MAY have side-effects; silently double-executing
     *   on a retry would violate ADR-0005 §"idempotency guard").
     *
     * Resource bindings that POST to a server-side-idempotent endpoint
     * (e.g. keyed inserts) may opt in explicitly with `{ idempotent: true }`.
     */
    idempotent?: boolean;
}
/** Internal HTTP client that handles authentication, retries, and error mapping. */
declare class HttpClient {
    private readonly apiKey;
    private readonly baseUrl;
    private readonly timeout;
    private readonly retries;
    private readonly rateLimitRetry;
    private readonly maxElapsedMs;
    constructor(config: CognitumConfig);
    /**
     * Perform an HTTP request against the Cognitum API.
     *
     * Automatically injects the API key header, serialises JSON bodies,
     * retries on transient errors with equal-jitter back-off per ADR-0005,
     * and maps HTTP error responses to typed SDK errors.
     */
    request<T>(method: string, path: string, body?: unknown, opts?: RequestOpts): Promise<T>;
}

interface CatalogBrowseOptions {
    category?: string;
}
/** Access the Cognitum product catalog. */
declare class CatalogResource {
    private readonly client;
    constructor(client: HttpClient);
    /** Browse available products, optionally filtered by category. */
    browse(options?: CatalogBrowseOptions): Promise<CatalogResponse>;
}

/** Manage orders and payments. */
declare class OrdersResource {
    private readonly client;
    constructor(client: HttpClient);
    /** Look up the status of an existing order by email. */
    status(email: string): Promise<Order>;
    /** Create a new presale order, returning a Stripe client secret for payment. */
    create(params: OrderCreateParams): Promise<OrderCreateResponse>;
}

/** Manage newsletter / waitlist leads. */
declare class LeadsResource {
    private readonly client;
    constructor(client: HttpClient);
    /** Subscribe an email to the notify-me / waitlist list. */
    subscribe(params: LeadSubscribeParams): Promise<void>;
}

/** Send contact-form messages. */
declare class ContactResource {
    private readonly client;
    constructor(client: HttpClient);
    /** Send a contact message. Triggers an email to the Cognitum team. */
    send(params: ContactSendParams): Promise<void>;
}

/** Manage OTA devices and firmware updates. */
declare class DevicesResource {
    private readonly client;
    constructor(client: HttpClient);
    /** Register a new device with its Ed25519 public key. */
    register(params: DeviceRegisterParams): Promise<void>;
    /** Check if a firmware update is available for the given device. */
    checkUpdate(deviceId: string): Promise<DeviceUpdateCheck>;
    /** Send a device heartbeat / health check. */
    heartbeat(deviceId: string): Promise<void>;
}

/** Interact with the MCP (Model Context Protocol) server. */
declare class McpResource {
    private readonly client;
    constructor(client: HttpClient);
    /** List all available MCP tools. */
    listTools(): Promise<McpTool[]>;
    /**
     * Call an MCP tool by name with the given arguments.
     * Uses JSON-RPC format over the SSE endpoint.
     */
    callTool(name: string, args?: Record<string, unknown>): Promise<McpToolCallResult>;
    /** Search the documentation knowledge base. */
    searchDocs(query: string, limit?: number): Promise<SearchResult[]>;
}

/** Interact with the Brain shared-knowledge system. */
declare class BrainResource {
    private readonly client;
    constructor(client: HttpClient);
    /** Share a new memory / knowledge entry. */
    share(params: BrainShareParams): Promise<BrainMemory>;
    /** Search the shared brain knowledge base. */
    search(query: string, options?: {
        limit?: number;
        tags?: string[];
    }): Promise<BrainSearchResult>;
    /** Vote on a brain memory entry (upvote / downvote). */
    vote(memoryId: string, direction: "up" | "down"): Promise<void>;
}

/** Base error class for all Cognitum SDK errors. */
declare class CognitumError extends Error {
    /** Machine-readable error code. */
    readonly code: string;
    /** HTTP status code, if applicable. */
    readonly statusCode?: number;
    constructor(message: string, code: string, statusCode?: number);
}
/** Thrown when the API key is missing or invalid (HTTP 401 / 403). */
declare class AuthError extends CognitumError {
    constructor(message?: string);
}
/** Thrown when the client is rate-limited (HTTP 429). */
declare class RateLimitError extends CognitumError {
    /** Milliseconds to wait before retrying, parsed from Retry-After header. */
    readonly retryAfterMs: number;
    constructor(retryAfterMs?: number, message?: string);
}
/** Thrown when a request fails validation (HTTP 400 / 422). */
declare class ValidationError extends CognitumError {
    constructor(message?: string);
}
/** Thrown when the requested resource does not exist (HTTP 404). */
declare class NotFoundError extends CognitumError {
    constructor(message?: string);
}

/**
 * Main entry point for the Cognitum SDK.
 *
 * @example
 * ```ts
 * import { Cognitum } from "@cognitum/sdk";
 *
 * const cog = new Cognitum({ apiKey: "sk-..." });
 * const catalog = await cog.catalog.browse();
 * ```
 */
declare class Cognitum {
    /** Browse the product / template catalog. */
    readonly catalog: CatalogResource;
    /** Create and look up orders. */
    readonly orders: OrdersResource;
    /** Subscribe leads to the waitlist. */
    readonly leads: LeadsResource;
    /** Send contact-form messages. */
    readonly contact: ContactResource;
    /** Manage OTA devices. */
    readonly devices: DevicesResource;
    /** Interact with the MCP tool server. */
    readonly mcp: McpResource;
    /** Shared knowledge / brain system. */
    readonly brain: BrainResource;
    private readonly client;
    constructor(config: CognitumConfig);
    /** Check the API health status. */
    health(): Promise<HealthResponse>;
}

export { AuthError, type BrainMemory, BrainResource, type BrainSearchResult, type BrainShareParams, CatalogResource, type CatalogResponse, Cognitum, type CognitumConfig, CognitumError, ContactResource, type ContactSendParams, type Device, type DeviceRegisterParams, type DeviceUpdateCheck, DevicesResource, type FleetStatus, type HealthResponse, HttpClient, type LeadSubscribeParams, LeadsResource, McpResource, type McpTool, type McpToolCallResult, NotFoundError, type Order, type OrderCreateParams, type OrderCreateResponse, OrdersResource, type Product, RateLimitError, type SearchResult, type ShippingAddress, ValidationError };
