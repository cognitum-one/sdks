import type { HttpClient } from "./client.js";
import type { ContactSendParams } from "./types.js";

/** Send contact-form messages. */
export class ContactResource {
  constructor(private readonly client: HttpClient) {}

  /** Send a contact message. Triggers an email to the Cognitum team. */
  async send(params: ContactSendParams): Promise<void> {
    await this.client.request<void>("POST", "/sendContactEmail", params);
  }
}
