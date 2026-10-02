export interface JwtPayload { sub: string; accountId: string; role: 'admin' | 'viewer'; purpose?: 'totp-challenge' }
export interface AuthUser { id: string; name: string; email: string; role: 'admin' | 'viewer'; accountId: string; accountName: string; isSuperAdmin: boolean }
