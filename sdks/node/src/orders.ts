import type { HttpClient } from "./client.js";
import type { Order, OrderCreateParams, OrderCreateResponse } from "./types.js";

/** Manage orders and payments. */
export class OrdersResource {
  constructor(private readonly client: HttpClient) {}

  /** Look up the status of an existing order by email. */
  async status(email: string): Promise<Order> {
    const params = new URLSearchParams({ email });
    return this.client.request<Order>("GET", `/lookupOrderStatus?${params}`);
  }

  /** Create a new presale order, returning a Stripe client secret for payment. */
  async create(params: OrderCreateParams): Promise<OrderCreateResponse> {
    return this.client.request<OrderCreateResponse>(
      "POST",
      "/createPresalePaymentIntent",
      params,
    );
  }
}
