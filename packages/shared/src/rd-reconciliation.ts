/** Membership/event scheduling; these timestamps do not measure full field freshness. */
export interface ReconciliationScheduleView {
  enabled: boolean;
  state: 'scheduled' | 'disabled' | 'unavailable' | 'paused';
  intervalMinutes: number;
  nextRunAt: string | null;
  lastAttemptAt: string | null;
  lastCompletedAt: string | null;
}
