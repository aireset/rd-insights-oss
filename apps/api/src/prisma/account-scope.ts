/**
 * Decisão de isolamento por model (PROTOCOLO §1). Escopado = toda query passa
 * `where: { accountId }` do usuário logado (os services fazem isso à mão — o
 * spec ao lado garante que a lista e o schema batem). Global = sem accountId:
 * corte manual obrigatório quando lido por id vindo do cliente.
 */
export const ACCOUNT_SCOPED_MODELS = ['User', 'InviteToken', 'RdConnection', 'Lead', 'LeadEvent', 'SyncRun', 'RdSegmentation', 'LeadSegmentMembership', 'WebhookLog', 'SavedView', 'UserTwoFactor', 'UserTwoFactorRecoveryCode', 'AiConfig', 'AiLog', 'AiClassificationPolicy', 'AiClassificationTask', 'AiClassificationAttempt', 'RdAnalyticsCache', 'DailyInsightSnapshot'] as const;
export const GLOBAL_MODELS = ['Account', 'RefreshToken', 'PasswordResetToken'] as const;
