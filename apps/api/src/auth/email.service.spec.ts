import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../config/env.schema';
import { EmailService, type MailTransport } from './email.service';

function make(env: Partial<Env>, transport: MailTransport | null) {
  const config = { get: (key: keyof Env) => env[key] } as unknown as ConfigService<Env, true>;
  return new EmailService(transport, config);
}

describe('EmailService', () => {
  it('sem SMTP entra em modo log: não envia, omite destinatário e mostra só 6 caracteres do token', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    for (const NODE_ENV of ['production', 'development'] as const) {
      const sent = await make({ NODE_ENV }, null).send({ to: 'ana@acme.com', subject: 'Reset', text: 'https://rd.example/redefinir-senha#abcdef-segredo-token' });
      expect(sent).toBe(false);
    }
    const logged = warn.mock.calls.flat().join(' ');
    expect(logged).toContain('#abcdef');
    expect(logged).not.toContain('segredo-token');
    expect(logged).not.toContain('ana@acme.com');
    warn.mockRestore();
  });

  it('envia link somente pelo transporte SMTP fornecido', async () => {
    const sendMail = vi.fn(async () => ({ messageId: 'mock-message' }));
    const mail = make({ NODE_ENV: 'test', SMTP_FROM: 'RD Insights <noreply@rd.example>' }, { sendMail });
    const result = await mail.send({ to: 'ana@acme.com', subject: 'Reset', text: 'https://rd.example/redefinir-senha#segredo-token' });
    expect(result).toBe(true);
    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({ to: 'ana@acme.com', from: 'RD Insights <noreply@rd.example>', text: expect.stringContaining('https://rd.example/redefinir-senha#segredo-token') }));
  });
});
