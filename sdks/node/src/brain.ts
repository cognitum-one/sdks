import type { HttpClient } from "./client.js";
import type {
  BrainShareParams,
  BrainMemory,
  BrainSearchResult,
} from "./types.js";

const BRAIN_BASE_URL = "https://pi.ruv.io";

/** Interact with the Brain shared-knowledge system. */
export class BrainResource {
  constructor(private readonly client: HttpClient) {}

  /** Share a new memory / knowledge entry. */
  async share(params: BrainShareParams): Promise<BrainMemory> {
    return this.client.request<BrainMemory>("POST", "/brain/share", params);
  }

  /** Search the shared brain knowledge base. */
  async search(
    query: string,
    options?: { limit?: number; tags?: string[] },
  ): Promise<BrainSearchResult> {
    const params: Record<string, unknown> = { query };
    if (options?.limit) params.limit = options.limit;
    if (options?.tags) params.tags = options.tags;
    return this.client.request<BrainSearchResult>(
      "POST",
      "/brain/search",
      params,
    );
  }

  /** Vote on a brain memory entry (upvote / downvote). */
  async vote(
    memoryId: string,
    direction: "up" | "down",
  ): Promise<void> {
    await this.client.request<void>("POST", "/brain/vote", {
      memoryId,
      direction,
    });
  }
}

// Re-export for internal use — the BrainResource uses the main client but
// callers may need to configure the brain base URL separately in the future.
export { BRAIN_BASE_URL };
