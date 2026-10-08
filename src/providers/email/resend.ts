import { Resend } from "resend";
import type { EmailMessage, EmailProvider, EmailSendResult } from "../types";

export class ResendEmailProvider implements EmailProvider {
  readonly name = "resend" as const;
  private client: Resend;

  constructor(
    apiKey: string,
    private from: string,
  ) {
    this.client = new Resend(apiKey);
  }

  async send(message: EmailMessage): Promise<EmailSendResult> {
    const { data, error } = await this.client.emails.send({
      from: this.from,
      to: [message.to],
      subject: message.subject,
      html: message.html,
      text: message.text,
      replyTo: message.replyTo,
      attachments: message.attachments?.map((a) => ({
        filename: a.filename,
        content: Buffer.from(a.content, "utf8"),
        contentType: a.contentType,
      })),
    });
    if (error) throw new Error(`Resend: ${error.name}: ${error.message}`);
    return { status: "sent", providerId: data?.id ?? null };
  }
}
