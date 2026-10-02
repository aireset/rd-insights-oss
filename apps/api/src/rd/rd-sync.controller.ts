import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { syncRunsQuerySchema, type SyncRunView, type SyncRunPage, type SyncRunsQuery } from '@rd/shared';
import { CurrentUser, RequireAdmin } from '../auth/auth.decorators';
import type { AuthUser } from '../auth/auth.types';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { RdJobsService } from './rd-jobs.service';
import { RdSyncService } from './rd-sync.service';

@Controller('rd/sync')
export class RdSyncController {
  constructor(private readonly jobs: RdJobsService, private readonly svc: RdSyncService) {}
  @RequireAdmin() @Post() start(@CurrentUser() u: AuthUser, @Body() body?: unknown): Promise<{ runId: string; runIds: string[] }> {
    const input = z.object({ segmentIds: z.array(z.string().trim().min(1).max(200)).max(100).transform((ids) => [...new Set(ids)]).optional() }).parse(body ?? {});
    return this.jobs.enqueueFullSync(u.accountId, input.segmentIds);
  }
  @Get('status') status(@CurrentUser() u: AuthUser): Promise<SyncRunView | null> { return this.jobs.status(u.accountId); }
  @Get('runs') runs(@CurrentUser() u: AuthUser, @Query(new ZodValidationPipe(syncRunsQuerySchema)) query: SyncRunsQuery): Promise<SyncRunPage> { return this.jobs.runs(u.accountId, query); }
}
