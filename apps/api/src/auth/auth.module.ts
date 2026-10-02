import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import nodemailer from 'nodemailer';
import type { Env } from '../config/env.schema';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { EMAIL_TRANSPORT, EmailService, type MailTransport } from './email.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';

@Module({
  imports: [JwtModule.register({})],
  controllers: [AuthController],
  providers: [
    AuthService,
    PasswordService,
    TokenService,
    JwtAuthGuard,
    EmailService,
    {
      provide: EMAIL_TRANSPORT,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>): MailTransport | null => {
        const host = config.get('SMTP_HOST', { infer: true });
        if (!host) return null;
        const user = config.get('SMTP_USER', { infer: true });
        const pass = config.get('SMTP_PASS', { infer: true });
        return nodemailer.createTransport({
          host,
          port: config.get('SMTP_PORT', { infer: true }) ?? (config.get('SMTP_SECURE', { infer: true }) ? 465 : 587),
          secure: config.get('SMTP_SECURE', { infer: true }),
          requireTLS: config.get('SMTP_REQUIRE_TLS', { infer: true }),
          ...(user && pass ? { auth: { user, pass } } : {}),
          connectionTimeout: 10_000,
          greetingTimeout: 10_000,
          socketTimeout: 15_000,
        });
      },
    },
  ],
  exports: [TokenService, JwtAuthGuard, EmailService, PasswordService],
})
export class AuthModule {}
