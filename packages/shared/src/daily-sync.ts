import { z } from 'zod';

export const refreshBudgetSchema = z.object({ dailyBudget: z.number().int().min(1).max(100_000) });
export type RefreshBudgetDto = z.infer<typeof refreshBudgetSchema>;
export type DailyScheduleState = 'scheduled' | 'paused' | 'disabled' | 'unavailable';
export interface DailySyncView {
  enabled: boolean;
  refresh: {
    state: DailyScheduleState; nextRunAt: string | null; lastCompletedAt: string | null;
    budget: { limit: number; used: number; resetsAt: string };
    run: { status: string; startedAt: string; leadsCompleted: number; step: string | null; page: number | null; error: string | null } | null;
  };
  catalog: { state: DailyScheduleState; nextRunAt: string | null; lastAttemptAt: string | null; lastCompletedAt: string | null; error: string | null; budget: { limit: number; used: number } };
}
