import { Body, Controller, Delete, Get, Param, Post, Put } from '@nestjs/common';
import { savedViewInputSchema, type SavedViewInput, type SavedViewView } from '@rd/shared';
import { CurrentUser } from '../auth/auth.decorators';
import type { AuthUser } from '../auth/auth.types';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { SavedViewsService } from './saved-views.service';

@Controller('leads/saved-views')
export class SavedViewsController {
  constructor(private readonly service: SavedViewsService) {}

  @Get() list(@CurrentUser() user: AuthUser): Promise<SavedViewView[]> {
    return this.service.list(user.accountId, user.id);
  }

  @Post() create(@CurrentUser() user: AuthUser, @Body(new ZodValidationPipe(savedViewInputSchema)) input: SavedViewInput): Promise<SavedViewView> {
    return this.service.create(user.accountId, user.id, input);
  }

  @Put(':id') update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body(new ZodValidationPipe(savedViewInputSchema)) input: SavedViewInput): Promise<SavedViewView> {
    return this.service.update(user.accountId, user.id, id, input);
  }

  @Delete(':id') async remove(@CurrentUser() user: AuthUser, @Param('id') id: string): Promise<{ success: true }> {
    await this.service.remove(user.accountId, user.id, id);
    return { success: true };
  }
}
