import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put } from '@nestjs/common';
import { CurrentUser, RequireAdmin } from '../../auth/auth.decorators';
import type { AuthUser } from '../../auth/auth.types';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { ClassificationService, policySchema } from './classification.service';
import { ClassificationJobs } from './classification-jobs';
import type { z } from 'zod';

@Controller('ai/classification')
export class ClassificationController {
  constructor(@Inject(ClassificationService) private readonly service: ClassificationService, @Inject(ClassificationJobs) private readonly jobs: ClassificationJobs) {}
  @Get('policy') @RequireAdmin() async policy(@CurrentUser() user: AuthUser) { return { ...await this.service.getPolicy(user.accountId), runtime: await this.jobs.readiness() }; }
  @Put('policy') @RequireAdmin() save(@CurrentUser() user: AuthUser, @Body(new ZodValidationPipe(policySchema)) input: z.infer<typeof policySchema>) { return this.service.savePolicy(user.accountId, input); }
  @Get('distribution') distribution(@CurrentUser() user: AuthUser) { return this.service.distribution(user.accountId); }
  @Post('all') @HttpCode(202) @RequireAdmin() async classifyAll(@CurrentUser() user: AuthUser) { const r = await this.service.enqueueUnclassified(user.accountId); void this.jobs.tick(); return r; }
  @Get('leads/:id') get(@CurrentUser() user: AuthUser, @Param('id') id: string) { return this.service.leadStatus(user.accountId, id); }
  @Post('leads/:id/retry') @RequireAdmin() async retry(@CurrentUser() user: AuthUser, @Param('id') id: string) { const task = await this.service.retry(user.accountId, id); void this.jobs.tick(); return { status: task.status }; }
}
