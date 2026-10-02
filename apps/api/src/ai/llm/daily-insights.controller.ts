import { Controller, Get, Query } from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser } from '../../auth/auth.decorators';
import type { AuthUser } from '../../auth/auth.types';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { DailyInsightsService } from './daily-insights.service';

const querySchema = z.object({ segmentIds: z.preprocess((value) => typeof value === 'string' ? value.split(',').map((id) => id.trim()).filter(Boolean) : value, z.array(z.string().trim().min(1).max(200)).max(30).optional()) }).strict();

@Controller('ai/daily-insights')
export class DailyInsightsController {
  constructor(private readonly service: DailyInsightsService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Query(new ZodValidationPipe(querySchema)) query: z.infer<typeof querySchema>) {
    return this.service.list(user.accountId, query.segmentIds);
  }
}
