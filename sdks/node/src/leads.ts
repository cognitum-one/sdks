import type { HttpClient } from "./client.js";
import type { LeadSubscribeParams } from "./types.js";

/** Manage newsletter / waitlist leads. */
export class LeadsResource {
  constructor(private readonly client: HttpClient) {}

  /** Subscribe an email to the notify-me / waitlist list. */
  async subscribe(params: LeadSubscribeParams): Promise<void> {
    await this.client.request<void>("POST", "/saveNotifyLead", params);
  }
}
