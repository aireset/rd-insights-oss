import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { AuthController } from './auth.controller';

describe('AuthController status codes', () => {
  it('recuperação de senha responde 200 (não é criação de recurso)', () => {
    for (const name of ['requestPasswordReset', 'resetPassword'] as const) {
      expect(Reflect.getMetadata('__httpCode__', AuthController.prototype[name])).toBe(200);
    }
  });
});
