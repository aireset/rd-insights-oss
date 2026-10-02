import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { ADMIN_KEY, IS_PUBLIC_KEY } from './auth.decorators';

// Rotas de escrita que o viewer pode usar (dados pessoais dele); qualquer outra escrita exige @RequireAdmin.
// Controladores de usuários checam o papel no service (UsersService.requireAdmin) e têm testes próprios.
const VIEWER_WRITES = new Set([
  'SavedViewsController.create', 'SavedViewsController.update', 'SavedViewsController.remove',
  'AuthController.setupTwoFactor', 'AuthController.enableTwoFactor', 'AuthController.disableTwoFactor', 'AuthController.regenerateRecoveryCodes',
  'TypedChatController.ask',
]);
const SERVICE_CHECKED = new Set(['UsersController']);
const METHODS = new Set([1, 2, 3, 4, 5]); // RequestMethod: POST=1, PUT=2, DELETE=3, PATCH=4, ALL=5 (GET=0)

const modules = import.meta.glob<Record<string, unknown>>('../**/*.controller.ts', { eager: true });

describe('rotas de escrita exigem administrador', () => {
  it('toda rota não-GET é admin, pública, do próprio usuário ou checada no service', () => {
    const offenders: string[] = [];
    let checked = 0;
    for (const mod of Object.values(modules)) {
      for (const value of Object.values(mod)) {
        if (typeof value !== 'function') continue;
        const proto = (value as { prototype: object }).prototype;
        for (const name of Object.getOwnPropertyNames(proto)) {
          const handler = (proto as Record<string, unknown>)[name];
          if (typeof handler !== 'function' || name === 'constructor') continue;
          const method = Reflect.getMetadata('method', handler);
          if (!METHODS.has(method)) continue;
          checked++;
          const id = `${(value as { name: string }).name}.${name}`;
          const admin = Reflect.getMetadata(ADMIN_KEY, handler) || Reflect.getMetadata(ADMIN_KEY, value);
          const open = Reflect.getMetadata(IS_PUBLIC_KEY, handler) || Reflect.getMetadata(IS_PUBLIC_KEY, value);
          if (!admin && !open && !VIEWER_WRITES.has(id) && !SERVICE_CHECKED.has((value as { name: string }).name)) offenders.push(id);
        }
      }
    }
    expect(checked).toBeGreaterThan(15);
    expect(offenders).toEqual([]);
  });
});
