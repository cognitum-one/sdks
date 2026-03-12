import { HttpClient } from "./client.js";
import { CatalogResource } from "./catalog.js";
import { OrdersResource } from "./orders.js";
import { LeadsResource } from "./leads.js";
import { ContactResource } from "./contact.js";
import { DevicesResource } from "./devices.js";
import { McpResource } from "./mcp.js";
import { BrainResource } from "./brain.js";
import type { CognitumConfig, HealthResponse } from "./types.js";

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
export class Cognitum {
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

  private readonly client: HttpClient;

  constructor(config: CognitumConfig) {
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
  async health(): Promise<HealthResponse> {
    return this.client.request<HealthResponse>("GET", "/health");
  }
}

// Re-export all types
export type {
  CognitumConfig,
  Product,
  CatalogResponse,
  Order,
  OrderCreateParams,
  OrderCreateResponse,
  ShippingAddress,
  LeadSubscribeParams,
  ContactSendParams,
  McpTool,
  McpToolCallResult,
  DeviceRegisterParams,
  DeviceUpdateCheck,
  Device,
  FleetStatus,
  HealthResponse,
  SearchResult,
  BrainShareParams,
  BrainMemory,
  BrainSearchResult,
} from "./types.js";

// Re-export errors
export {
  CognitumError,
  AuthError,
  RateLimitError,
  ValidationError,
  NotFoundError,
} from "./errors.js";

// Re-export resource classes for advanced usage
export { CatalogResource } from "./catalog.js";
export { OrdersResource } from "./orders.js";
export { LeadsResource } from "./leads.js";
export { ContactResource } from "./contact.js";
export { DevicesResource } from "./devices.js";
export { McpResource } from "./mcp.js";
export { BrainResource } from "./brain.js";
export { HttpClient } from "./client.js";
