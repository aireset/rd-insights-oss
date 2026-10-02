let accessToken: string | null = null;
let onUnauthorized: (() => void) | null = null;
export const authStore = {
  get: (): string | null => accessToken,
  set: (t: string | null): void => { accessToken = t; },
  setOnUnauthorized: (fn: (() => void) | null): void => { onUnauthorized = fn; },
  notifyUnauthorized: (): void => { onUnauthorized?.(); },
};
