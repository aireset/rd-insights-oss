import { Body, Controller, Get, Post, Query, Res } from '@nestjs/common';
import { rdCredentialsSchema, rdSegmentationSchema, rdSegmentationSelectionSchema, type RdSegmentationSelectionDto, type RdConnectionView, type RdCredentialsDto, type RdSegmentation, type RdSegmentationDto } from '@rd/shared';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { CurrentUser, Public, RequireAdmin } from '../auth/auth.decorators';
import type { AuthUser } from '../auth/auth.types';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { RdConnectionService } from './rd-connection.service';
import { RdWebhookSubscriptionsService } from './rd-webhook-subscriptions.service';

const callbackSchema = z.object({ code: z.string().min(1), state: z.string().min(1) });

@Controller('rd')
export class RdConnectionController {
  constructor(private readonly svc: RdConnectionService, private readonly webhooks: RdWebhookSubscriptionsService) {}

  /** Ao ativar a conexão, tenta registrar o tempo real (idempotente); falha não bloqueia a seleção. */
  private ativarTempoReal(accountId: string, view: RdConnectionView): RdConnectionView {
    if (view.status === 'active') void this.webhooks.register(accountId).catch(() => undefined);
    return view;
  }

  @Get('connection') connection(@CurrentUser() u: AuthUser): Promise<RdConnectionView> { return this.svc.view(u.accountId); }

  @RequireAdmin() @Post('credentials')
  credentials(@CurrentUser() u: AuthUser, @Body(new ZodValidationPipe(rdCredentialsSchema)) dto: RdCredentialsDto): Promise<RdConnectionView> { return this.svc.saveCredentials(u.accountId, dto); }

  /** O front abre esta URL (window.location) — o RD redireciona de volta p/ /api/rd/callback. */
  @RequireAdmin() @Get('authorize-url')
  async authorizeUrl(@CurrentUser() u: AuthUser): Promise<{ url: string }> { return { url: await this.svc.authorizeUrl(u.accountId) }; }

  @Public() @Get('callback')
  async callback(@Query(new ZodValidationPipe(callbackSchema)) q: { code: string; state: string }, @Res() reply: FastifyReply): Promise<void> {
    const to = await this.svc.handleCallback(q.code, q.state);
    void reply.redirect(to, 302);
  }

  @RequireAdmin() @Get('segmentations') segmentations(@CurrentUser() u: AuthUser): Promise<RdSegmentation[]> { return this.svc.segmentations(u.accountId); }

  @RequireAdmin() @Post('segmentation')
  segmentation(@CurrentUser() u: AuthUser, @Body(new ZodValidationPipe(rdSegmentationSchema)) dto: RdSegmentationDto): Promise<RdConnectionView> { return this.svc.chooseSegmentation(u.accountId, dto).then((v) => this.ativarTempoReal(u.accountId, v)); }

  @RequireAdmin() @Post('segmentations/selection')
  selectSegmentations(@CurrentUser() u: AuthUser, @Body(new ZodValidationPipe(rdSegmentationSelectionSchema)) dto: RdSegmentationSelectionDto): Promise<RdConnectionView> { return this.svc.setSegmentations(u.accountId, dto.segmentationIds).then((v) => this.ativarTempoReal(u.accountId, v)); }
}
