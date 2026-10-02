import { Body, Controller, Get, Post } from '@nestjs/common';
import { refreshBudgetSchema, type DailySyncView, type RefreshBudgetDto, type ReconciliationScheduleView, type SegmentCoverageView } from '@rd/shared';
import { CurrentUser, RequireAdmin } from '../auth/auth.decorators';
import type { AuthUser } from '../auth/auth.types';
import { RdJobsService } from './rd-jobs.service';
import { RdSchedulerService } from './rd-scheduler.service';
import { ZodValidationPipe } from '../common/zod-validation.pipe';

@Controller('rd/sync')
export class RdScheduleController {
  constructor(private readonly scheduler: RdSchedulerService, private readonly jobs: RdJobsService) {}

  @Get('daily') daily(@CurrentUser() user: AuthUser): Promise<DailySyncView> {
    return this.scheduler.dailyStatus(user.accountId);
  }

  @RequireAdmin() @Post('refresh') refresh(@CurrentUser() user: AuthUser): Promise<{ runId: string; runIds: string[] }> {
    return this.jobs.enqueueRefresh(user.accountId);
  }

  @RequireAdmin() @Post('catalog') catalog(@CurrentUser() user: AuthUser): Promise<{ runId: string; runIds: string[] }> {
    return this.jobs.enqueueCatalog(user.accountId);
  }

  @RequireAdmin() @Post('refresh/budget') budget(@CurrentUser() user: AuthUser, @Body(new ZodValidationPipe(refreshBudgetSchema)) dto: RefreshBudgetDto): Promise<void> {
    return this.scheduler.updateRefreshBudget(user.accountId, dto.dailyBudget);
  }

  @Get('schedule') status(@CurrentUser() user: AuthUser): Promise<ReconciliationScheduleView> {
    return this.scheduler.status(user.accountId);
  }

  @Get('coverage') coverage(@CurrentUser() user: AuthUser): Promise<SegmentCoverageView[]> {
    return this.scheduler.coverage(user.accountId);
  }

  @RequireAdmin() @Post('reconcile') reconcile(@CurrentUser() user: AuthUser): Promise<{ runId: string; runIds: string[] }> {
    return this.jobs.enqueueReconciliation(user.accountId);
  }
}
