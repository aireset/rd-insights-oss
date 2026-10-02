import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { changeUserRoleSchema, inviteAcceptSchema, inviteCreateSchema, type ChangeUserRoleDto, type InviteAcceptDto, type InviteCreateDto } from '@rd/shared';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { CurrentUser, Public } from '../auth/auth.decorators';
import type { AuthUser } from '../auth/auth.types';
import { UsersService } from './users.service';

@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  listMembers(@CurrentUser() actor: AuthUser) { return this.users.listMembers(actor); }

  @Get('invitations')
  listInvites(@CurrentUser() actor: AuthUser) { return this.users.listInvites(actor); }

  @Post('invitations')
  createInvite(@CurrentUser() actor: AuthUser, @Body(new ZodValidationPipe(inviteCreateSchema)) dto: InviteCreateDto) { return this.users.createInvite(actor, dto); }

  @Public() @Throttle({ default: { limit: 10, ttl: 60_000 } }) @Post('invitations/accept')
  acceptInvite(@Body(new ZodValidationPipe(inviteAcceptSchema)) dto: InviteAcceptDto) { return this.users.acceptInvite(dto); }

  @Post('invitations/:inviteId/resend') @HttpCode(200)
  resendInvite(@CurrentUser() actor: AuthUser, @Param('inviteId') inviteId: string) { return this.users.resendInvite(actor, inviteId); }

  @Delete('invitations/:inviteId')
  cancelInvite(@CurrentUser() actor: AuthUser, @Param('inviteId') inviteId: string) { return this.users.cancelInvite(actor, inviteId); }

  @Delete(':userId')
  removeUser(@CurrentUser() actor: AuthUser, @Param('userId') userId: string) { return this.users.removeUser(actor, userId); }

  @Patch(':userId/role')
  updateRole(@CurrentUser() actor: AuthUser, @Param('userId') userId: string, @Body(new ZodValidationPipe(changeUserRoleSchema)) dto: ChangeUserRoleDto) {
    return this.users.updateRole(actor, userId, dto.role);
  }
}
