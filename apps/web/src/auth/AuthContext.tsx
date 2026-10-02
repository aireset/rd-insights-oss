import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { AuthResponse, LoginDto, LoginResponse, RegisterDto, SessionUser, TwoFactorChallengeResponse } from '@rd/shared';
import { api, refreshOnce } from '../lib/apiClient';
import { authStore } from '../lib/authStore';

type Status = 'loading' | 'authenticated' | 'anonymous';
interface Ctx { status: Status; user: SessionUser | null; login: (d: LoginDto) => Promise<TwoFactorChallengeResponse | null>; verifyTwoFactor: (challengeToken: string, code: string) => Promise<void>; register: (d: RegisterDto) => Promise<void>; logout: () => Promise<void> }
const AuthContext = createContext<Ctx | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const [status, setStatus] = useState<Status>('loading');
  const [user, setUser] = useState<SessionUser | null>(null);
  const apply = useCallback((r: AuthResponse) => { authStore.set(r.accessToken); setUser(r.user); setStatus('authenticated'); }, []);
  const clear = useCallback(() => { authStore.set(null); setUser(null); setStatus('anonymous'); }, []);

  useEffect(() => {
    let active = true;
    refreshOnce().then(async (t) => {
      if (!active) return;
      if (!t) return clear();
      try { setUser(await api.get<SessionUser>('/auth/me')); setStatus('authenticated'); } catch { clear(); }
    });
    authStore.setOnUnauthorized(clear);
    return () => { active = false; authStore.setOnUnauthorized(null); };
  }, [clear]);

  const value = useMemo<Ctx>(() => ({
    status, user,
    login: async (d) => {
      const result = await api.post<LoginResponse>('/auth/login', d);
      if ('twoFactorRequired' in result) return result;
      apply(result); return null;
    },
    verifyTwoFactor: async (challengeToken, code) => apply(await api.post<AuthResponse>('/auth/login/2fa', { challengeToken, code })),
    register: async (d) => apply(await api.post<AuthResponse>('/auth/register', d)),
    logout: async () => { try { await api.post('/auth/logout'); } finally { clear(); } },
  }), [status, user, apply, clear]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
export function useAuth(): Ctx { const c = useContext(AuthContext); if (!c) throw new Error('useAuth fora do AuthProvider'); return c; }
