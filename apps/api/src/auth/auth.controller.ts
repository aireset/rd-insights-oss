import { Body, Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';
import { loginSchema, passwordResetRequestSchema, passwordResetSchema, registerSchema, twoFactorChallengeSchema, twoFactorCodeSchema, twoFactorDisableSchema, twoFactorPasswordSchema, type AuthConfig, type AuthResponse, type LoginDto, type LoginResponse, type PasswordResetDto, type PasswordResetRequestDto, type PasswordResetRequestResponse, type RegisterDto, type SessionUser, type TwoFactorChallengeDto, type TwoFactorCodeDto, type TwoFactorDisableDto, type TwoFactorPasswordDto } from '@rd/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import type { Env } from '../config/env.schema';
import { AuthService, type AuthResult } from './auth.service';
import { CurrentUser, Public } from './auth.decorators';
import type { AuthUser } from './auth.types';
import { TokenService } from './token.service';

const COOKIE = 'refresh_token';
const PATH = '/api/auth';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService, private readonly tokens: TokenService, private readonly config: ConfigService<Env, true>) {}

  private respond(reply: FastifyReply, r: AuthResult): AuthResponse {
    reply.setCookie(COOKIE, r.refresh, { httpOnly: true, secure: this.config.get('NODE_ENV', { infer: true }) === 'production', sameSite: 'strict', path: PATH, maxAge: Math.floor(this.tokens.refreshMaxAgeMs() / 1000) });
    return { accessToken: r.accessToken, user: r.user };
  }

  @Public() @Throttle({ default: { limit: 5, ttl: 60_000 } }) @Post('register')
  async register(@Body(new ZodValidationPipe(registerSchema)) dto: RegisterDto, @Res({ passthrough: true }) reply: FastifyReply): Promise<AuthResponse> {
    return this.respond(reply, await this.auth.register(dto));
  }

  @Public() @Throttle({ default: { limit: 10, ttl: 60_000 } }) @Post('login')
  async login(@Body(new ZodValidationPipe(loginSchema)) dto: LoginDto, @Res({ passthrough: true }) reply: FastifyReply): Promise<LoginResponse> {
    const result = await this.auth.login(dto);
    return 'twoFactorRequired' in result ? result : this.respond(reply, result);
  }

  @Public() @Throttle({ default: { limit: 5, ttl: 60_000 } }) @Post('login/2fa')
  async verifyTwoFactor(@Body(new ZodValidationPipe(twoFactorChallengeSchema)) dto: TwoFactorChallengeDto, @Res({ passthrough: true }) reply: FastifyReply): Promise<AuthResponse> {
    return this.respond(reply, await this.auth.verifyTwoFactorChallenge(dto));
  }

  @Public() @Throttle({ default: { limit: 5, ttl: 60_000 } }) @Post(['password-reset/request', 'forgot']) @HttpCode(200)
  requestPasswordReset(@Body(new ZodValidationPipe(passwordResetRequestSchema)) dto: PasswordResetRequestDto): PasswordResetRequestResponse {
    return this.auth.requestPasswordReset(dto);
  }

  @Public() @Throttle({ default: { limit: 10, ttl: 60_000 } }) @Post(['password-reset/confirm', 'reset']) @HttpCode(200)
  async resetPassword(@Body(new ZodValidationPipe(passwordResetSchema)) dto: PasswordResetDto, @Res({ passthrough: true }) reply: FastifyReply): Promise<{ ok: true }> {
    await this.auth.resetPassword(dto);
    reply.clearCookie(COOKIE, { path: PATH });
    return { ok: true };
  }

  @Public() @Throttle({ default: { limit: 30, ttl: 60_000 } }) @Post('refresh')
  async refresh(@Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply): Promise<AuthResponse> {
    return this.respond(reply, await this.auth.refresh(req.cookies?.[COOKIE] ?? ''));
  }

  @Public() @Post('logout')
  async logout(@Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply): Promise<{ ok: true }> {
    await this.auth.logout(req.cookies?.[COOKIE]);
    reply.clearCookie(COOKIE, { path: PATH });
    return { ok: true };
  }

  @Get('me')
  me(@CurrentUser() user: AuthUser): SessionUser { return user; }

  @Get('totp')
  twoFactorStatus(@CurrentUser() user: AuthUser) { return this.auth.twoFactorStatus(user); }

  @Post('totp/setup')
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  setupTwoFactor(@CurrentUser() user: AuthUser, @Body(new ZodValidationPipe(twoFactorPasswordSchema)) dto: TwoFactorPasswordDto) {
    return this.auth.setupTwoFactor(user, dto.password);
  }

  @Post('totp/enable')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  enableTwoFactor(@CurrentUser() user: AuthUser, @Body(new ZodValidationPipe(twoFactorCodeSchema)) dto: TwoFactorCodeDto) {
    return this.auth.enableTwoFactor(user, dto.code);
  }

  @Post('totp/disable')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async disableTwoFactor(@CurrentUser() user: AuthUser, @Body(new ZodValidationPipe(twoFactorDisableSchema)) dto: TwoFactorDisableDto): Promise<{ ok: true }> {
    await this.auth.disableTwoFactor(user, dto);
    return { ok: true };
  }

  @Post('totp/recovery-codes')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  regenerateRecoveryCodes(@CurrentUser() user: AuthUser, @Body(new ZodValidationPipe(twoFactorDisableSchema)) dto: TwoFactorDisableDto) {
    return this.auth.regenerateRecoveryCodes(user, dto);
  }

  @Public() @Get('config')
  authConfig(): Promise<AuthConfig> { return this.auth.authConfig(); }
}
