import { Controller, Get, Query } from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser } from '../auth/auth.decorators';
import type { AuthUser } from '../auth/auth.types';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { DashboardService } from './dashboard.service';
import { RdAnalyticsService } from '../rd/rd-analytics.service';
import { LEADS_DATE_TIME_ZONE } from '@rd/shared';

const isTimeZone = (timeZone: string) => {
  try { new Intl.DateTimeFormat('en-US', { timeZone }); return true; }
  catch { return false; }
};

const querySchema = z.object({
  period: z.coerce.number().pipe(z.union([z.literal(7), z.literal(30), z.literal(90)])).default(30),
  timeZone: z.string().trim().min(1).max(100).default(LEADS_DATE_TIME_ZONE).refine(isTimeZone, 'Fuso horário inválido'),
  segmentIds: z.preprocess((value) => typeof value === 'string' ? value.split(',').map((id) => id.trim()).filter(Boolean) : value, z.array(z.string().trim().min(1).max(200)).optional()).transform((ids) => ids ? [...new Set(ids)] : undefined),
  segmentMatch: z.enum(['any', 'all']).default('any'),
});
const comparisonSchema = z.object({ segmentAId: z.string().trim().min(1).max(200), segmentBId: z.string().trim().min(1).max(200) });

@Controller('dashboard')
export class DashboardController {
  constructor(private readonly svc: DashboardService, private readonly analytics: RdAnalyticsService) {}

  @Get('analytics')
  analyticsGlobal(@CurrentUser() user: AuthUser) {
    return this.analytics.dashboard(user.accountId);
  }

  @Get('new-leads')
  newLeads(@CurrentUser() user: AuthUser, @Query(new ZodValidationPipe(querySchema)) query: z.infer<typeof querySchema>) {
    return this.svc.newLeads(user.accountId, query);
  }

  @Get('summary')
  summary(@CurrentUser() user: AuthUser, @Query(new ZodValidationPipe(querySchema)) query: z.infer<typeof querySchema>) {
    return this.svc.summary(user.accountId, query);
  }

  @Get('segment-comparison')
  compareSegments(@CurrentUser() user: AuthUser, @Query(new ZodValidationPipe(comparisonSchema)) query: z.infer<typeof comparisonSchema>) {
    return this.svc.compareSegments(user.accountId, query.segmentAId, query.segmentBId);
  }
}
