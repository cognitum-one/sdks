/** Configuration for the Cognitum SDK client. */
export interface CognitumConfig {
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
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

export interface Product {
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

export interface CatalogResponse {
  products: Product[];
  total: number;
}

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

export interface Order {
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

export interface ShippingAddress {
  name: string;
  line1: string;
  line2?: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
}

export interface OrderCreateParams {
  email: string;
  name: string;
  shippingAddress?: ShippingAddress;
  metadata?: Record<string, unknown>;
}

export interface OrderCreateResponse {
  orderId: string;
  clientSecret: string;
  amount: number;
  currency: string;
}

// ---------------------------------------------------------------------------
// Leads
// ---------------------------------------------------------------------------

export interface LeadSubscribeParams {
  email: string;
  source?: string;
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Contact
// ---------------------------------------------------------------------------

export interface ContactSendParams {
  name: string;
  email: string;
  message: string;
  subject?: string;
}

// ---------------------------------------------------------------------------
// MCP
// ---------------------------------------------------------------------------

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpToolCallResult {
  content: Array<{ type: string; text?: string; data?: unknown }>;
  isError?: boolean;
  /** Nested result when the server wraps the response. */
  result?: {
    content: Array<{ type: string; text?: string; data?: unknown }>;
    isError?: boolean;
  };
}

// ---------------------------------------------------------------------------
// Devices / OTA
// ---------------------------------------------------------------------------

export interface DeviceRegisterParams {
  deviceId: string;
  publicKey: string;
  model?: string;
  firmwareVersion?: string;
}

export interface DeviceUpdateCheck {
  updateAvailable: boolean;
  currentVersion: string;
  latestVersion?: string;
  downloadUrl?: string;
  releaseNotes?: string;
  size?: number;
}

export interface Device {
  deviceId: string;
  model: string;
  firmwareVersion: string;
  lastSeen: string;
  status: "online" | "offline" | "updating";
}

export interface FleetStatus {
  totalDevices: number;
  onlineDevices: number;
  updatingDevices: number;
  devices: Device[];
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

export interface HealthResponse {
  status: "ok" | "degraded" | "down";
  version?: string;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export interface SearchResult {
  title: string;
  content: string;
  url?: string;
  score: number;
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Brain
// ---------------------------------------------------------------------------

export interface BrainShareParams {
  title: string;
  content: string;
  tags?: string[];
  visibility?: "public" | "private";
}

export interface BrainMemory {
  id: string;
  title: string;
  content: string;
  tags: string[];
  visibility: "public" | "private";
  votes: number;
  createdAt: string;
}

export interface BrainSearchResult {
  memories: BrainMemory[];
  total: number;
}
