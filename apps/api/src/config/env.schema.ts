import { z } from 'zod';

const optionalString = z.preprocess((v) => (v === '' ? undefined : v), z.string().optional());
const optionalPort = z.preprocess((v) => (v === '' ? undefined : v), z.coerce.number().int().min(1).max(65535).optional());

/** Booleano vindo do .env ('1'/'true' = true), com default e '' tratado como ausente. */
const optionalBool = (def: 'true' | 'false') =>
  z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.string().optional().default(def).transform((v) => v === '1' || v === 'true'),
  );

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(22501),
  CORS_ORIGIN: z.string().default('http://localhost:22500'),
  APP_URL: z.string().url().default('http://localhost:22500'),
  DATABASE_URL: z.string().url(),
  REDIS_URL: optionalString,
  RD_RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(60),
  JWT_ACCESS_SECRET: z.string().min(16, 'JWT_ACCESS_SECRET muito curto'),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL: z.string().default('7d'),
  SECRETS_KEY: optionalString,
  WEB_DIST_DIR: optionalString,
  RD_API_BASE_URL: z.string().url().default('https://api.rd.services'),
  RD_CLIENT_ID: optionalString,
  RD_CLIENT_SECRET: optionalString,
  RD_RECONCILIATION_ENABLED: optionalBool('true'),
  RD_REFRESH_ENABLED: optionalBool('true'),
  RD_RECONCILIATION_INTERVAL_MINUTES: z.coerce.number().int().min(1).max(1440).default(60),
  TRUST_PROXY: optionalString,
  REGISTRATION_OPEN: optionalBool('false'),
  SUPER_ADMIN_EMAIL: z.preprocess((v) => (v === '' ? undefined : v), z.string().toLowerCase().optional()),
  SMTP_HOST: optionalString,
  SMTP_PORT: optionalPort,
  SMTP_SECURE: optionalBool('false'),
  SMTP_REQUIRE_TLS: optionalBool('true'),
  SMTP_USER: optionalString,
  SMTP_PASS: optionalString,
  SMTP_FROM: optionalString,
}).superRefine((env, ctx) => {
  if (env.NODE_ENV === 'production' && !env.SECRETS_KEY) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['SECRETS_KEY'], message: 'SECRETS_KEY é obrigatória em produção' });
  }
  if (env.NODE_ENV === 'production' && !env.REDIS_URL) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['REDIS_URL'], message: 'REDIS_URL é obrigatória em produção' });
  }
  const smtpExtra = env.SMTP_PORT !== undefined || env.SMTP_FROM !== undefined || env.SMTP_USER !== undefined || env.SMTP_PASS !== undefined;
  if (!env.SMTP_HOST && smtpExtra) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['SMTP_HOST'], message: 'SMTP_HOST é obrigatória quando outras variáveis SMTP são informadas' });
  if (env.SMTP_HOST && !env.SMTP_FROM) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['SMTP_FROM'], message: 'SMTP_FROM é obrigatória quando SMTP_HOST é informada' });
  if (Boolean(env.SMTP_USER) !== Boolean(env.SMTP_PASS)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['SMTP_PASS'], message: 'SMTP_USER e SMTP_PASS devem ser informadas juntas' });
  if (!['http:', 'https:'].includes(new URL(env.APP_URL).protocol)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['APP_URL'], message: 'APP_URL deve usar HTTP ou HTTPS' });
});
export type Env = z.infer<typeof envSchema>;

export function validateEnv(raw: Record<string, unknown>): Env {
  const r = envSchema.safeParse(raw);
  if (!r.success) throw new Error(`Configuração inválida:\n${r.error.issues.map((i) => `- ${i.path.join('.')}: ${i.message}`).join('\n')}`);
  return r.data;
}
