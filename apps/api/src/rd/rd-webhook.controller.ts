import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { WebhookStatusView } from '@rd/shared';
import { CurrentUser, Public, RequireAdmin } from '../auth/auth.decorators';
import type { AuthUser } from '../auth/auth.types';
import { RdWebhookService } from './rd-webhook.service';
import { RdWebhookJobsService } from './rd-webhook-jobs.service';
import { RdWebhookSubscriptionsService } from './rd-webhook-subscriptions.service';

@Controller('rd/webhooks')
export class RdWebhookController {
  constructor(private readonly ingress: RdWebhookService, private readonly jobs: RdWebhookJobsService, private readonly subscriptions: RdWebhookSubscriptionsService) {}

  @Public() @Post(':accountId/:token') @HttpCode(200)
  @Throttle({ default: { limit: 300, ttl: 60_000 } })
  receive(@Param('accountId') accountId: string, @Param('token') token: string, @Body() body: unknown): Promise<{ accepted: true }> {
    return this.ingress.receive(accountId, token, body);
  }

  @Get('status') status(@CurrentUser() user: AuthUser): Promise<WebhookStatusView> { return this.jobs.status(user.accountId); }
  @RequireAdmin() @Post('register') @HttpCode(204)
  register(@CurrentUser() user: AuthUser): Promise<void> { return this.subscriptions.register(user.accountId); }
  @RequireAdmin() @Post('retry/:id') @HttpCode(204)
  retry(@CurrentUser() user: AuthUser, @Param('id') id: string): Promise<void> { return this.jobs.retry(user.accountId, id); }
}
