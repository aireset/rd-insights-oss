export interface WebhookStatusView {
  configured: boolean;
  registeredAt: string | null;
  registrationError: string | null;
  worker: 'running' | 'stopped';
  pending: number;
  failed: number;
  lastReceivedAt: string | null;
  lastProcessedAt: string | null;
  failures: Array<{ id: string; eventType: string; receivedAt: string; attempts: number }>;
}
