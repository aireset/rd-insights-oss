import { Body, Controller, Post } from '@nestjs/common';
import { CurrentUser } from '../../auth/auth.decorators';
import type { AuthUser } from '../../auth/auth.types';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { TypedChatService, typedChatSchema } from './typed-chat.service';

@Controller('ai/chat')
export class TypedChatController {
  constructor(private readonly service: TypedChatService) {}
  @Post() ask(@CurrentUser() user: AuthUser, @Body(new ZodValidationPipe(typedChatSchema)) body: unknown) { return this.service.ask(user.accountId, body); }
}
