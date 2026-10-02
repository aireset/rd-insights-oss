import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ACCOUNT_SCOPED_MODELS, GLOBAL_MODELS } from './account-scope';

// Regra do PROTOCOLO §1: todo model do schema toma uma decisão explícita de isolamento.
const schema = readFileSync(join(__dirname, '..', '..', 'prisma', 'schema.prisma'), 'utf8');
const modelos = [...schema.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)].map(([, name, body]) => ({ name: name!, body: body! }));

describe('account-scope: decisão de isolamento por model', () => {
  const conhecidos = new Set<string>([...ACCOUNT_SCOPED_MODELS, ...GLOBAL_MODELS]);

  it('todo model está em ACCOUNT_SCOPED_MODELS ou GLOBAL_MODELS', () => {
    expect(modelos.length).toBeGreaterThan(0);
    expect(modelos.map((m) => m.name).filter((m) => !conhecidos.has(m))).toEqual([]);
  });

  it('nenhum nome nas listas sobrou sem model no schema', () => {
    const doSchema = new Set(modelos.map((m) => m.name));
    expect([...conhecidos].filter((m) => !doSchema.has(m))).toEqual([]);
  });

  it('nenhum model está nas duas listas', () => {
    const scoped = new Set<string>(ACCOUNT_SCOPED_MODELS);
    expect(GLOBAL_MODELS.filter((m) => scoped.has(m))).toEqual([]);
  });

  it('todo model escopado tem a coluna accountId', () => {
    for (const m of modelos.filter((x) => (ACCOUNT_SCOPED_MODELS as readonly string[]).includes(x.name))) {
      expect(m.body, `${m.name} sem accountId`).toMatch(/^\s+accountId\s+String/m);
    }
  });
});
