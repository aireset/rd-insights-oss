import { Module } from '@nestjs/common';
import { AiConfigController } from './ai-config.controller';
import { AiConfigService } from './ai-config.service';
import { DailyInsightsController } from './daily-insights.controller';
import { DailyInsightsJobs } from './daily-insights.jobs';
import { DailyInsightsService } from './daily-insights.service';

@Module({ controllers: [AiConfigController, DailyInsightsController], providers: [AiConfigService, DailyInsightsService, DailyInsightsJobs], exports: [DailyInsightsJobs] })
export class AiModule {}
