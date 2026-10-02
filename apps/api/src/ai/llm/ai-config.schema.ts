import { z } from 'zod';

export const aiConfigInputSchema = z.object({
  provider: z.enum(['openai-compatible', 'omniroute']),
  baseUrl: z.string().trim().min(1).max(500),
  model: z.string().trim().min(1).max(120),
  enabled: z.boolean(),
  monthlyBudgetCents: z.number().int().min(1).max(100_000_000),
  requestsPerMinute: z.number().int().min(1).max(600),
  apiKey: z.string().max(500).optional(),
});
