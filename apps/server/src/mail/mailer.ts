// 寄信（Task 邀請與預覽邀請共用，ADR-0012、ADR-0015）。有設定 SMTP（`<前綴>SMTP_URL`、`<前綴>SMTP_FROM`）
// 時寄出；沒有設定時不寄，由邀請人複製連結。寄信失敗只記 log，不讓邀請失敗。

import nodemailer from "nodemailer";
import type { Logger } from "../logger";

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  /** 是否有設定 SMTP。 */
  readonly enabled: boolean;
  /** 寄出成功回 true；沒有設定或寄信失敗回 false。 */
  send(message: MailMessage): Promise<boolean>;
}

/** 沒有設定 SMTP：不寄。 */
export const NO_MAILER: Mailer = { enabled: false, send: async () => false };

export interface SmtpConfig {
  /** 例如 `smtps://user:pass@smtp.example.com:465`。 */
  url: string;
  /** 寄件者，例如 `Team <noreply@example.com>`。 */
  from: string;
}

export function createSmtpMailer(config: SmtpConfig, logger: Logger): Mailer {
  const transport = nodemailer.createTransport(config.url);
  const log = logger.child({ component: "mailer" });
  return {
    enabled: true,
    async send(message) {
      try {
        await transport.sendMail({ from: config.from, ...message });
        return true;
      } catch (error) {
        // 錯誤訊息可能含 SMTP 的帳號，只記收件者與錯誤類別。
        log.warn({ to: message.to, err: (error as Error).name }, "寄信失敗");
        return false;
      }
    },
  };
}

/** 測試用：記下寄出的信。 */
export class RecordingMailer implements Mailer {
  readonly enabled = true;
  readonly sent: MailMessage[] = [];

  async send(message: MailMessage): Promise<boolean> {
    this.sent.push(message);
    return true;
  }
}
