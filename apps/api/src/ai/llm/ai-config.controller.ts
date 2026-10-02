import { Body, Controller, Get, Inject, Put } from '@nestjs/common';
import { CurrentUser, RequireAdmin } from '../../auth/auth.decorators';
import type { AuthUser } from '../../auth/auth.types';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { AiConfigService } from './ai-config.service';
import { aiConfigInputSchema } from './ai-config.schema';
import type { AiConfigInput } from './ai-config.service';

@Controller('ai/config')
@RequireAdmin()
export class AiConfigController {
  constructor(@Inject(AiConfigService) private readonly service: AiConfigService) {}
  @Get() get(@CurrentUser() user: AuthUser) { return this.service.get(user.accountId); }
  @Put() save(@CurrentUser() user: AuthUser, @Body(new ZodValidationPipe(aiConfigInputSchema)) body: unknown) { return this.service.save(user.accountId, body as AiConfigInput); }
}
