import { z } from 'zod';

export const registerSchema = z.object({
  accountName: z.string().trim().min(2).max(80),
  name: z.string().trim().min(2).max(80),
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(10).max(128),
});
export type RegisterDto = z.infer<typeof registerSchema>;

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1),
});
export type LoginDto = z.infer<typeof loginSchema>;

export const twoFactorChallengeSchema = z.object({ challengeToken: z.string().min(20), code: z.string().regex(/^(?:\d{6}|[a-f0-9]{4}(?:-[a-f0-9]{4}){7})$/i) });
export type TwoFactorChallengeDto = z.infer<typeof twoFactorChallengeSchema>;
export const twoFactorPasswordSchema = z.object({ password: z.string().min(1) });
export type TwoFactorPasswordDto = z.infer<typeof twoFactorPasswordSchema>;
export const twoFactorCodeSchema = z.object({ code: z.string().regex(/^\d{6}$/) });
export type TwoFactorCodeDto = z.infer<typeof twoFactorCodeSchema>;
export const twoFactorDisableSchema = z.object({ password: z.string().min(1), code: z.string().regex(/^(?:\d{6}|[a-f0-9]{4}(?:-[a-f0-9]{4}){7})$/i) });
export type TwoFactorDisableDto = z.infer<typeof twoFactorDisableSchema>;

export const passwordResetRequestSchema = z.object({ email: z.string().trim().toLowerCase().email() });
export type PasswordResetRequestDto = z.infer<typeof passwordResetRequestSchema>;

export const passwordResetSchema = z.object({ token: z.string().min(32).max(128), password: z.string().min(10).max(128) });
export type PasswordResetDto = z.infer<typeof passwordResetSchema>;
export interface PasswordResetRequestResponse { message: string }

export const inviteCreateSchema = z.object({ email: z.string().trim().toLowerCase().email(), role: z.enum(['admin', 'viewer']) });
export type InviteCreateDto = z.infer<typeof inviteCreateSchema>;
export const inviteAcceptSchema = z.object({ token: z.string().min(40).max(128), name: z.string().trim().min(2).max(80), password: z.string().min(10).max(128) });
export type InviteAcceptDto = z.infer<typeof inviteAcceptSchema>;
export const changeUserRoleSchema = z.object({ role: z.enum(['admin', 'viewer']) });
export type ChangeUserRoleDto = z.infer<typeof changeUserRoleSchema>;
export interface AccountMember { id: string; name: string; email: string; role: 'admin' | 'viewer'; createdAt: string }
export interface PendingInvite { id: string; email: string; role: 'admin' | 'viewer'; expiresAt: string }

export interface SessionUser { id: string; name: string; email: string; role: 'admin' | 'viewer'; accountId: string; accountName: string; isSuperAdmin: boolean }
export interface AuthConfig { registrationOpen: boolean; smtpConfigured: boolean }
export interface AuthResponse { accessToken: string; user: SessionUser }
export interface TwoFactorChallengeResponse { twoFactorRequired: true; challengeToken: string }
export type LoginResponse = AuthResponse | TwoFactorChallengeResponse;
