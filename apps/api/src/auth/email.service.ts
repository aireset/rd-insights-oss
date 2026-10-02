import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.schema';

export const EMAIL_TRANSPORT = Symbol('EMAIL_TRANSPORT');

export interface MailMessage { to: string; subject: string; text: string }

export interface MailTransport {
  sendMail(message: { from: string } & MailMessage): Promise<unknown>;
}

@Injectable()
export class EmailService implements OnModuleInit {
  private readonly logger = new Logger(EmailService.name);

  constructor(
    @Inject(EMAIL_TRANSPORT) private readonly transport: MailTransport | null,
    private readonly config: ConfigService<Env, true>,
  ) {}

  onModuleInit(): void { if (!this.isConfigured()) this.logUnavailable(); }

  isConfigured(): boolean { return this.transport !== null && Boolean(this.config.get('SMTP_FROM', { infer: true })); }

  logUnavailable(): void {
    this.logger.warn('SMTP não configurado: e-mails de recuperação de senha ficam em modo log (não são enviados).');
  }

  async send(message: MailMessage): Promise<boolean> {
    const from = this.config.get('SMTP_FROM', { infer: true });
    if (!this.transport || !from) {
      // Modo log: sem destinatário e só os 6 primeiros caracteres do token.
      const masked = message.text.replace(/#([A-Za-z0-9_-]{6})[A-Za-z0-9_-]+/g, '#$1…');
      this.logger.warn(`SMTP não configurado; e-mail "${message.subject}" NÃO enviado. ${masked}`);
      return false;
    }
    try {
      await this.transport.sendMail({ from, ...message });
      return true;
    } catch {
      this.logger.error('Password reset email delivery failed; no recipient or token was logged.');
      return false;
    }
  }
}
