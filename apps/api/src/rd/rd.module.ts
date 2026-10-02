import { Module } from '@nestjs/common';
import { RdConnectionController } from './rd-connection.controller';
import { RdConnectionService } from './rd-connection.service';
import { RdSyncController } from './rd-sync.controller';
import { RdSyncService } from './rd-sync.service';
import { RdJobsService } from './rd-jobs.service';
import { RdScheduleController } from './rd-schedule.controller';
import { RdSchedulerService } from './rd-scheduler.service';
import { RdRefreshService } from './rd-refresh.service';
import { RdRefreshBudgetService } from './rd-refresh-budget.service';
import { RdCatalogService } from './rd-catalog.service';
import { RdWebhookController } from './rd-webhook.controller';
import { RdWebhookService } from './rd-webhook.service';
import { RdWebhookJobsService } from './rd-webhook-jobs.service';
import { RdWebhookProcessorService } from './rd-webhook-processor.service';
import { RdWebhookSubscriptionsService } from './rd-webhook-subscriptions.service';

import { RdRateLimiter } from './rd-rate-limiter';
import { RdAnalyticsService } from './rd-analytics.service';
import { AiModule } from '../ai/llm/ai.module';

@Module({
  imports: [AiModule],
  controllers: [RdConnectionController, RdSyncController, RdScheduleController, RdWebhookController],
  providers: [RdRateLimiter, RdConnectionService, RdSyncService, RdJobsService, RdSchedulerService, RdRefreshService, RdRefreshBudgetService, RdCatalogService, RdAnalyticsService, RdWebhookService, RdWebhookJobsService, RdWebhookProcessorService, RdWebhookSubscriptionsService],
  exports: [RdConnectionService, RdJobsService, RdAnalyticsService],
})
export class RdModule {}
