import type { HttpClient } from "./client.js";
import type { CatalogResponse } from "./types.js";

export interface CatalogBrowseOptions {
  category?: string;
}

/** Access the Cognitum product catalog. */
export class CatalogResource {
  constructor(private readonly client: HttpClient) {}

  /** Browse available products, optionally filtered by category. */
  async browse(options?: CatalogBrowseOptions): Promise<CatalogResponse> {
    const params = new URLSearchParams();
    if (options?.category) {
      params.set("category", options.category);
    }
    const query = params.toString();
    const path = `/apiCatalog${query ? `?${query}` : ""}`;
    return this.client.request<CatalogResponse>("GET", path);
  }
}
