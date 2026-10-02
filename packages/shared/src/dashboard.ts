export interface DashboardSummaryView {
  period: 7 | 30 | 90;
  timeZone: string;
  stages: Array<{ name: string; count: number }>;
  conversions: Array<{ identifier: string; leadCount: number }>;
  tags: Array<{ name: string; leadCount: number }>;
  locations: Array<{ city: string; state: string | null; leadCount: number }>;
  heatmap: Array<{ dayOfWeek: number; hour: number; count: number }>;
}
