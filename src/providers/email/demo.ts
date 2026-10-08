import type { EmailMessage, EmailProvider, EmailSendResult } from "../types";

/** Demo email: nothing leaves the machine. The notifications table is the Outbox. */
export class DemoEmailProvider implements EmailProvider {
  readonly name = "demo" as const;

  async send(_message: EmailMessage): Promise<EmailSendResult> {
    void _message;
    return { status: "demo", providerId: null };
  }
}
