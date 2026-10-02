# RD Insights — Plano 1: fundação, conexão RD e lista de leads

**Goal:** Criar conta → logar → conectar o RD Station Marketing (OAuth) → escolher a segmentação "todos" → carga inicial dos leads → ver a lista com busca/filtros e a ficha do lead.

**Architecture:** Monorepo pnpm com `apps/api` (NestJS 11 + Fastify + Prisma 6 + Postgres), `apps/web` (Vite + React 19 + react-router 7 + react-query) e `packages/shared` (zod). Auth JWT curto + refresh opaco em cookie HttpOnly. Segredos do RD cifrados com AES-256-GCM por serviço implementado neste repositório. Sync roda em processo com `SyncRun` retomável (ponytail: BullMQ entra no Plano 2 junto com webhooks/cron).

**Tech Stack:** Node 22, pnpm 10, TypeScript 5.7, NestJS 11, Fastify 5, Prisma 6, Postgres 16, zod 3, vitest 2, React 19, Vite 6, @tanstack/react-query 5, react-router-dom 7, lucide-react.

**Spec:** `docs/superpowers/specs/2026-09-27-rd-insights-design.md` (seções 1–4, 6, 7). Fora deste plano: webhooks, delta, analytics, dashboard, IA, deploy (planos 2 e 3).

**Orientação:** trate este plano como referência de requisitos e implemente usando o fluxo de contribuição e as convenções do repositório onde ele for aplicado.

---

## Mapa de arquivos

```
rd-insights/
├─ package.json, pnpm-workspace.yaml, tsconfig.base.json, eslint.config.js
├─ docker-compose.yml, .env.example
├─ packages/shared/           # zod + tipos compartilhados
│  └─ src/index.ts, src/auth.ts, src/leads.ts, src/rd.ts
├─ apps/api/
│  ├─ package.json, tsconfig.json, nest-cli.json, vitest.config.ts
│  ├─ prisma/schema.prisma
│  ├─ scripts/boot-check.js
│  └─ src/
│     ├─ main.ts, app.module.ts
│     ├─ config/env.schema.ts
│     ├─ prisma/prisma.service.ts, prisma.module.ts, account-scope.ts, account-scope.spec.ts
│     ├─ common/errors.ts, zod-validation.pipe.ts, all-exceptions.filter.ts,
│     │         crypto-secrets.ts (+spec), http.ts
│     ├─ auth/password.service.ts, token.service.ts, jwt-auth.guard.ts,
│     │       auth.decorators.ts, auth.types.ts, auth.service.ts (+spec),
│     │       auth.controller.ts, auth.module.ts
│     ├─ health/health.controller.ts
│     ├─ rd/rd-client.ts (+spec), rd-connection.service.ts, rd-connection.controller.ts,
│     │    rd-sync.service.ts (+spec), rd-sync.controller.ts, rd.module.ts
│     └─ leads/leads.service.ts (+spec), leads.controller.ts, leads.module.ts
└─ apps/web/
   ├─ package.json, vite.config.ts, tsconfig.json, index.html
   └─ src/main.tsx, App.tsx, styles.css
      ├─ lib/apiClient.ts, authStore.ts, queryClient.ts
      ├─ auth/AuthContext.tsx, ProtectedRoute.tsx
      ├─ app/AppLayout.tsx
      └─ features/auth/LoginPage.tsx, RegisterPage.tsx
                 onboarding/ConectarRdPage.tsx
                 leads/LeadsPage.tsx, LeadDetalhePage.tsx, leadsApi.ts
```

---

### Task 1: Esqueleto do monorepo

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `eslint.config.js`, `docker-compose.yml`, `.env.example`, `.npmrc`

- [ ] **Step 1: Arquivos da raiz**

`package.json`:
```json
{
  "name": "rd-insights",
  "private": true,
  "engines": { "node": ">=20" },
  "packageManager": "pnpm@10.22.0",
  "scripts": {
    "dev": "pnpm --filter @rd/shared build && pnpm --parallel --filter @rd/api --filter @rd/web dev",
    "build": "pnpm -r build",
    "test": "pnpm -r test",
    "lint": "eslint .",
    "typecheck": "pnpm -r typecheck",
    "db:up": "docker compose up -d",
    "db:migrate:dev": "pnpm --filter @rd/api prisma:migrate:dev"
  },
  "pnpm": { "onlyBuiltDependencies": ["@prisma/client", "@prisma/engines", "@swc/core", "argon2", "esbuild", "prisma"] },
  "devDependencies": {
    "@eslint/js": "^9.17.0",
    "eslint": "^9.17.0",
    "typescript": "^5.7.2",
    "typescript-eslint": "^8.19.0"
  }
}
```

`pnpm-workspace.yaml`:
```yaml
packages:
  - "apps/*"
  - "packages/*"
```

`.npmrc`:
```
auto-install-peers=true
strict-peer-dependencies=false
```

`tsconfig.base.json`:
```json
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": true,
    "sourceMap": true
  }
}
```

`eslint.config.js`:
```js
// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'warn',
    },
  },
);
```

`docker-compose.yml`:
```yaml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: rd
      POSTGRES_PASSWORD: rd
      POSTGRES_DB: rd
    ports:
      - "${POSTGRES_PORT:-22506}:5432"
    volumes:
      - postgres-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U rd"]
      interval: 5s
      timeout: 3s
      retries: 10
  redis:
    image: redis:7-alpine
    ports:
      - "${REDIS_PORT:-22509}:6379"
volumes:
  postgres-data:
```

`.env.example`:
```
NODE_ENV=development
PORT=22501
CORS_ORIGIN=http://localhost:22500
APP_URL=http://localhost:22500
DATABASE_URL=postgresql://rd:rd@localhost:22506/rd
REDIS_URL=redis://localhost:22509
JWT_ACCESS_SECRET=troque-por-32-chars-aleatorios-openssl-rand
JWT_ACCESS_TTL=15m
JWT_REFRESH_TTL=7d
# openssl rand -base64 32  (obrigatoria em producao)
SECRETS_KEY=
# Base da API do RD (so muda em teste)
RD_API_BASE_URL=https://api.rd.services
```

- [ ] **Step 2: Commit**

```bash
```

---

### Task 2: `packages/shared` — schemas zod

**Files:**
- Create: `packages/shared/package.json`, `tsconfig.json`, `tsup.config.ts`, `src/index.ts`, `src/auth.ts`, `src/leads.ts`, `src/rd.ts`, `src/leads.test.ts`

- [ ] **Step 1: Manifesto e build**

`packages/shared/package.json`:
```json
{
  "name": "@rd/shared",
  "version": "0.1.0",
  "private": true,
  "main": "./dist/index.js",
  "module": "./dist/index.mjs",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "import": { "types": "./dist/index.d.ts", "default": "./dist/index.mjs" }, "require": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } } },
  "files": ["dist"],
  "scripts": { "build": "tsup", "dev": "tsup --watch", "typecheck": "tsc -p tsconfig.json --noEmit", "test": "vitest run" },
  "dependencies": { "zod": "^3.24.1" },
  "devDependencies": { "tsup": "^8.3.5", "typescript": "^5.7.2", "vitest": "^2.1.8" }
}
```

`packages/shared/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "./dist", "rootDir": "./src", "module": "NodeNext", "moduleResolution": "NodeNext", "lib": ["ES2022", "DOM"], "verbatimModuleSyntax": false },
  "include": ["src/**/*"],
  "exclude": ["dist", "node_modules", "**/*.test.ts"]
}
```

`packages/shared/tsup.config.ts`:
```ts
import { defineConfig } from 'tsup';
export default defineConfig({ entry: ['src/index.ts'], format: ['cjs', 'esm'], dts: true, clean: true, sourcemap: true });
```

- [ ] **Step 2: Teste do schema de filtros (falha primeiro)**

`packages/shared/src/leads.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { leadsQuerySchema } from './leads';

describe('leadsQuerySchema', () => {
  it('aplica defaults e converte tipos vindos da query string', () => {
    const q = leadsQuerySchema.parse({ page: '2', tags: 'a,b', oportunidade: 'true' });
    expect(q).toMatchObject({ page: 2, pageSize: 50, tags: ['a', 'b'], oportunidade: true, sort: 'lastConversionAt', dir: 'desc' });
  });
  it('rejeita pageSize acima de 200', () => {
    expect(() => leadsQuerySchema.parse({ pageSize: '500' })).toThrow();
  });
});
```

Run: `corepack pnpm --filter @rd/shared test`
Expected: FAIL — `Cannot find module './leads'`.

- [ ] **Step 3: Schemas**

`packages/shared/src/auth.ts`:
```ts
import { z } from 'zod';

export const registerSchema = z.object({
  accountName: z.string().trim().min(2).max(80),
  name: z.string().trim().min(2).max(80),
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(10).max(128),
});
export type RegisterDto = z.infer<typeof registerSchema>;

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1),
});
export type LoginDto = z.infer<typeof loginSchema>;

export interface SessionUser { id: string; name: string; email: string; role: 'admin' | 'viewer'; accountId: string; accountName: string }
export interface AuthResponse { accessToken: string; user: SessionUser }
```

`packages/shared/src/leads.ts`:
```ts
import { z } from 'zod';

const csv = z.preprocess((v) => (typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : v), z.array(z.string()).optional());
const bool = z.preprocess((v) => (v === 'true' ? true : v === 'false' ? false : v), z.boolean().optional());

export const LEAD_SORTS = ['name', 'lastConversionAt', 'conversionsCount', 'rdCreatedAt', 'lifecycleStage'] as const;

export const leadsQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  tags: csv,
  lifecycleStage: csv,
  oportunidade: bool,
  cidade: z.string().trim().max(80).optional(),
  uf: z.string().trim().length(2).optional(),
  conversao: z.string().trim().max(200).optional(),
  de: z.coerce.date().optional(),
  ate: z.coerce.date().optional(),
  sort: z.enum(LEAD_SORTS).default('lastConversionAt'),
  dir: z.enum(['asc', 'desc']).default('desc'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
export type LeadsQuery = z.infer<typeof leadsQuerySchema>;

export interface LeadRow {
  id: string; rdUuid: string; name: string | null; email: string | null; phone: string | null;
  city: string | null; state: string | null; company: string | null; jobTitle: string | null;
  tags: string[]; lifecycleStage: string | null; opportunity: boolean; fit: string | null; interest: number | null;
  conversionsCount: number; firstConversionAt: string | null; lastConversionAt: string | null; rdCreatedAt: string | null;
}
export interface LeadEventRow { id: string; type: 'CONVERSION' | 'OPPORTUNITY'; identifier: string; occurredAt: string; payload: Record<string, unknown> }
export interface LeadDetail extends LeadRow { customFields: Record<string, unknown>; events: LeadEventRow[] }
export interface Page<T> { items: T[]; total: number; page: number; pageSize: number }
export interface LeadFacets { tags: Array<{ value: string; count: number }>; lifecycleStages: Array<{ value: string; count: number }>; conversoes: Array<{ value: string; count: number }> }
```

`packages/shared/src/rd.ts`:
```ts
import { z } from 'zod';

export const rdCredentialsSchema = z.object({
  clientId: z.string().trim().min(8).max(200),
  clientSecret: z.string().trim().min(8).max(200),
});
export type RdCredentialsDto = z.infer<typeof rdCredentialsSchema>;

export const rdSegmentationSchema = z.object({ segmentationId: z.string().trim().min(1), segmentationName: z.string().trim().min(1).max(200) });
export type RdSegmentationDto = z.infer<typeof rdSegmentationSchema>;

export type RdConnectionStatus = 'pending' | 'authorized' | 'active' | 'reauth_required' | 'error';
export interface RdConnectionView {
  status: RdConnectionStatus; hasClientSecret: boolean; clientId: string | null;
  segmentationId: string | null; segmentationName: string | null; lastFullSyncAt: string | null; lastError: string | null;
}
export interface RdSegmentation { id: string; name: string; standard: boolean }
export interface SyncRunView { id: string; kind: string; startedAt: string; finishedAt: string | null; cursor: number; stats: { lidos: number; criados: number; atualizados: number; erros: number; totalPaginas?: number }; error: string | null }
```

`packages/shared/src/index.ts`:
```ts
export * from './auth';
export * from './leads';
export * from './rd';
```

- [ ] **Step 4: Rodar teste e build**

Run: `corepack pnpm install && corepack pnpm --filter @rd/shared test && corepack pnpm --filter @rd/shared build`
Expected: 2 testes PASS; `dist/index.js`, `dist/index.mjs`, `dist/index.d.ts` gerados.

- [ ] **Step 5: Commit**

```bash
```

---

### Task 3: API — manifesto, Prisma schema e guard de escopo por conta

**Files:**
- Create: `apps/api/package.json`, `tsconfig.json`, `nest-cli.json`, `vitest.config.ts`, `prisma/schema.prisma`, `src/prisma/account-scope.ts`, `src/prisma/account-scope.spec.ts`, `src/prisma/prisma.service.ts`, `src/prisma/prisma.module.ts`

- [ ] **Step 1: Manifesto**

`apps/api/package.json`:
```json
{
  "name": "@rd/api",
  "version": "0.1.0",
  "private": true,
  "main": "dist/main.js",
  "scripts": {
    "dev": "nest start --watch",
    "build": "nest build",
    "start": "node dist/main.js",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run",
    "test:boot": "nest build && node scripts/boot-check.js",
    "prisma:generate": "dotenv -e ../../.env -- prisma generate",
    "prisma:migrate": "prisma migrate deploy",
    "prisma:migrate:dev": "dotenv -e ../../.env -- prisma migrate dev"
  },
  "dependencies": {
    "@fastify/cookie": "^11.0.2",
    "@fastify/helmet": "^13.0.1",
    "@fastify/static": "^8.0.0",
    "@nestjs/common": "^11.0.0",
    "@nestjs/config": "^4.0.0",
    "@nestjs/core": "^11.0.0",
    "@nestjs/jwt": "^11.0.0",
    "@nestjs/platform-fastify": "^11.0.0",
    "@nestjs/throttler": "^6.4.0",
    "@prisma/client": "^6.1.0",
    "@rd/shared": "workspace:*",
    "argon2": "^0.41.1",
    "fastify": "^5.2.0",
    "reflect-metadata": "^0.2.2",
    "rxjs": "^7.8.1",
    "zod": "^3.24.1"
  },
  "devDependencies": {
    "@nestjs/cli": "^11.0.0",
    "@nestjs/testing": "^11.0.0",
    "@swc/core": "^1.10.7",
    "@types/node": "^22.10.5",
    "dotenv-cli": "^7.4.4",
    "prisma": "^6.1.0",
    "typescript": "^5.7.2",
    "unplugin-swc": "^1.5.1",
    "vitest": "^2.1.8"
  }
}
```

`apps/api/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "module": "CommonJS", "moduleResolution": "Node", "target": "ES2021",
    "outDir": "./dist", "rootDir": "./src", "baseUrl": "./", "types": ["node"],
    "experimentalDecorators": true, "emitDecoratorMetadata": true, "useDefineForClassFields": false,
    "verbatimModuleSyntax": false, "isolatedModules": false, "noUncheckedIndexedAccess": false, "skipLibCheck": true
  },
  "include": ["src/**/*"],
  "exclude": ["dist", "node_modules", "**/*.spec.ts"]
}
```

`apps/api/nest-cli.json`:
```json
{ "$schema": "https://json.schemastore.org/nest-cli", "collection": "@nestjs/schematics", "sourceRoot": "src", "compilerOptions": { "deleteOutDir": true } }
```

`apps/api/vitest.config.ts`:
```ts
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { globals: true, environment: 'node', root: '.', include: ['src/**/*.spec.ts'] },
  plugins: [swc.vite()],
});
```

- [ ] **Step 2: Schema Prisma**

`apps/api/prisma/schema.prisma`:
```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

enum UserRole {
  admin
  viewer
}

enum RdConnectionStatus {
  pending
  authorized
  active
  reauth_required
  error
}

enum LeadEventType {
  CONVERSION
  OPPORTUNITY
}

enum SyncKind {
  full
  delta
  webhook
  analytics
}

model Account {
  id        String   @id @default(uuid())
  name      String
  createdAt DateTime @default(now())
  users     User[]
  rd        RdConnection?
  leads     Lead[]
  syncRuns  SyncRun[]
}

model User {
  id           String   @id @default(uuid())
  accountId    String
  account      Account  @relation(fields: [accountId], references: [id])
  name         String
  email        String   @unique
  passwordHash String
  role         UserRole @default(admin)
  createdAt    DateTime @default(now())
  lastLoginAt  DateTime?
  refreshTokens RefreshToken[]

  @@index([accountId])
}

model RefreshToken {
  id        String   @id @default(uuid())
  userId    String
  user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  tokenHash String   @unique
  expiresAt DateTime
  revokedAt DateTime?
  createdAt DateTime @default(now())

  @@index([userId])
}

model RdConnection {
  id               String             @id @default(uuid())
  accountId        String             @unique
  account          Account            @relation(fields: [accountId], references: [id])
  clientId         String
  clientSecret     String             // cifrado (enc:v1:…)
  accessToken      String?            // cifrado
  refreshToken     String?            // cifrado
  expiresAt        DateTime?
  segmentationId   String?
  segmentationName String?
  webhookUuids     String[]           @default([])
  status           RdConnectionStatus @default(pending)
  lastError        String?
  lastFullSyncAt   DateTime?
  lastDeltaSyncAt  DateTime?
  createdAt        DateTime           @default(now())
  updatedAt        DateTime           @updatedAt
}

model Lead {
  id                String    @id @default(uuid())
  accountId         String
  account           Account   @relation(fields: [accountId], references: [id])
  rdUuid            String
  name              String?
  email             String?
  phone             String?
  city              String?
  state             String?
  country           String?
  jobTitle          String?
  company           String?
  website           String?
  tags              String[]  @default([])
  lifecycleStage    String?
  opportunity       Boolean   @default(false)
  fit               String?
  interest          Int?
  conversionsCount  Int       @default(0)
  firstConversionAt DateTime?
  lastConversionAt  DateTime?
  rdCreatedAt       DateTime?
  customFields      Json      @default("{}")
  raw               Json?
  aiSummary         String?
  aiScore           String?
  aiReason          String?
  aiAt              DateTime?
  syncedAt          DateTime  @default(now())
  events            LeadEvent[]

  @@unique([accountId, rdUuid])
  @@index([accountId, lastConversionAt])
  @@index([accountId, lifecycleStage])
  @@index([accountId, email])
}

model LeadEvent {
  id         String        @id @default(uuid())
  accountId  String
  leadId     String
  lead       Lead          @relation(fields: [leadId], references: [id], onDelete: Cascade)
  type       LeadEventType
  identifier String
  occurredAt DateTime
  payload    Json          @default("{}")

  @@unique([leadId, type, identifier, occurredAt])
  @@index([accountId, occurredAt])
  @@index([accountId, identifier])
}

model SyncRun {
  id         String    @id @default(uuid())
  accountId  String
  account    Account   @relation(fields: [accountId], references: [id])
  kind       SyncKind
  startedAt  DateTime  @default(now())
  finishedAt DateTime?
  cursor     Int       @default(0)
  stats      Json      @default("{}")
  error      String?

  @@index([accountId, startedAt])
}
```

- [ ] **Step 3: Guard-as-test do escopo (falha primeiro)**

`apps/api/src/prisma/account-scope.spec.ts`:
```ts
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
```

Run: `corepack pnpm install && corepack pnpm --filter @rd/api test`
Expected: FAIL — `Cannot find module './account-scope'`.

- [ ] **Step 4: Listas de escopo + PrismaService**

`apps/api/src/prisma/account-scope.ts`:
```ts
/**
 * Decisão de isolamento por model (PROTOCOLO §1). Escopado = toda query passa
 * `where: { accountId }` do usuário logado (os services fazem isso à mão — o
 * spec ao lado garante que a lista e o schema batem). Global = sem accountId:
 * corte manual obrigatório quando lido por id vindo do cliente.
 */
export const ACCOUNT_SCOPED_MODELS = ['User', 'RdConnection', 'Lead', 'LeadEvent', 'SyncRun'] as const;
export const GLOBAL_MODELS = ['Account', 'RefreshToken'] as const;
```

`apps/api/src/prisma/prisma.service.ts`:
```ts
import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit(): Promise<void> {
    await this.$connect();
  }
  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
```

`apps/api/src/prisma/prisma.module.ts`:
```ts
import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

@Global()
@Module({ providers: [PrismaService], exports: [PrismaService] })
export class PrismaModule {}
```

- [ ] **Step 5: Gerar client, migrar, rodar teste**

```bash
cp .env.example .env   # ajustar JWT_ACCESS_SECRET
corepack pnpm db:up
corepack pnpm --filter @rd/api prisma:generate
corepack pnpm --filter @rd/api prisma:migrate:dev --name init
corepack pnpm --filter @rd/api test
```
Expected: migration `init` aplicada; 4 testes PASS.

- [ ] **Step 6: Commit**

```bash
```

---

### Task 4: API — config, erros, cifra de segredos, filtro de exceções, boot

**Files:**
- Create: `apps/api/src/config/env.schema.ts`, `src/common/errors.ts`, `src/common/zod-validation.pipe.ts`, `src/common/crypto-secrets.ts`, `src/common/crypto-secrets.spec.ts`, `src/common/all-exceptions.filter.ts`, `src/health/health.controller.ts`, `src/app.module.ts`, `src/main.ts`, `scripts/boot-check.js`

- [ ] **Step 1: Teste da cifra (falha primeiro)**

`apps/api/src/common/crypto-secrets.spec.ts`:
```ts
import { afterEach, describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret, isEncrypted, secretsKeyConfigured } from './crypto-secrets';

describe('crypto-secrets', () => {
  afterEach(() => { delete process.env.SECRETS_KEY; });

  it('cifra e decifra com SECRETS_KEY; valor cifrado tem prefixo enc:v1:', () => {
    process.env.SECRETS_KEY = 'uma-passphrase-qualquer';
    const c = encryptSecret('segredo');
    expect(isEncrypted(c)).toBe(true);
    expect(c).not.toContain('segredo');
    expect(decryptSecret(c)).toBe('segredo');
  });

  it('sem SECRETS_KEY é passthrough (texto puro) e avisa via secretsKeyConfigured=false', () => {
    expect(secretsKeyConfigured()).toBe(false);
    expect(encryptSecret('x')).toBe('x');
  });

  it('valor adulterado falha sem vazar conteúdo', () => {
    process.env.SECRETS_KEY = 'k';
    const c = encryptSecret('segredo')!;
    const ruim = c.slice(0, -2) + 'AA';
    expect(() => decryptSecret(ruim)).toThrow(/adulterado|SECRETS_KEY/);
  });
});
```

Run: `corepack pnpm --filter @rd/api test`
Expected: FAIL — módulo `./crypto-secrets` não existe.

- [ ] **Step 2: Implementar `crypto-secrets.ts` neste repositório**

Implemente cifra autenticada AES-256-GCM, validação de configuração da chave e tratamento seguro de ciphertext inválido. Use um identificador de contexto próprio desta aplicação; não compartilhe nem copie chaves entre instalações.

- [ ] **Step 3: Config, erros, pipe, filtro**

`apps/api/src/config/env.schema.ts`:
```ts
import { z } from 'zod';

const optionalString = z.preprocess((v) => (v === '' ? undefined : v), z.string().optional());

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(22501),
  CORS_ORIGIN: z.string().default('http://localhost:22500'),
  APP_URL: z.string().url().default('http://localhost:22500'),
  DATABASE_URL: z.string().url(),
  REDIS_URL: optionalString,
  JWT_ACCESS_SECRET: z.string().min(16, 'JWT_ACCESS_SECRET muito curto'),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL: z.string().default('7d'),
  SECRETS_KEY: optionalString,
  WEB_DIST_DIR: optionalString,
  RD_API_BASE_URL: z.string().url().default('https://api.rd.services'),
  TRUST_PROXY: optionalString,
}).superRefine((env, ctx) => {
  if (env.NODE_ENV === 'production' && !env.SECRETS_KEY) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['SECRETS_KEY'], message: 'SECRETS_KEY é obrigatória em produção' });
  }
});
export type Env = z.infer<typeof envSchema>;

export function validateEnv(raw: Record<string, unknown>): Env {
  const r = envSchema.safeParse(raw);
  if (!r.success) throw new Error(`Configuração inválida:\n${r.error.issues.map((i) => `- ${i.path.join('.')}: ${i.message}`).join('\n')}`);
  return r.data;
}
```

`apps/api/src/common/errors.ts`:
```ts
import { HttpException, HttpStatus } from '@nestjs/common';

export class AppError extends HttpException {
  constructor(message: string, status: HttpStatus, code: string, details?: Record<string, unknown>) {
    super(details ? { message, code, details } : { message, code }, status);
  }
}
export class NotFoundError extends AppError { constructor(m = 'Recurso não encontrado') { super(m, HttpStatus.NOT_FOUND, 'NOT_FOUND'); } }
export class ConflictError extends AppError { constructor(m = 'Conflito de estado', d?: Record<string, unknown>) { super(m, HttpStatus.CONFLICT, 'CONFLICT', d); } }
export class ForbiddenError extends AppError { constructor(m = 'Acesso negado') { super(m, HttpStatus.FORBIDDEN, 'FORBIDDEN'); } }
export class UnauthorizedError extends AppError { constructor(m = 'Não autenticado') { super(m, HttpStatus.UNAUTHORIZED, 'UNAUTHORIZED'); } }
export class BusinessError extends AppError { constructor(m: string) { super(m, HttpStatus.UNPROCESSABLE_ENTITY, 'BUSINESS_RULE'); } }
/** Falha do RD (401 após refresh, 5xx, rede) — 502 sem vazar corpo/URL. */
export class RdProviderError extends AppError { constructor(m: string, readonly providerStatus?: number) { super(m, HttpStatus.BAD_GATEWAY, 'RD_PROVIDER_ERROR'); } }
```

`apps/api/src/common/zod-validation.pipe.ts`:
```ts
import type { PipeTransform } from '@nestjs/common';
import type { ZodTypeAny, z } from 'zod';

export class ZodValidationPipe<T extends ZodTypeAny> implements PipeTransform {
  constructor(private readonly schema: T) {}
  transform(value: unknown): z.infer<T> { return this.schema.parse(value); }
}
```

`apps/api/src/common/all-exceptions.filter.ts`:
```ts
import { Catch, HttpException, HttpStatus, Logger, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import { Prisma } from '@prisma/client';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';

type ReplyWithSendFile = FastifyReply & { sendFile?: (path: string) => unknown };
interface ErrorBody { statusCode: number; code: string; message: string; errors?: Array<{ path: string; message: string }>; details?: Record<string, unknown> }

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const reply = http.getResponse<ReplyWithSendFile>();
    const req = http.getRequest<FastifyRequest>();
    const body = this.toBody(exception);
    // SPA fallback: GET fora de /api com a API servindo o front → index.html.
    if (body.statusCode === 404 && req.method === 'GET' && !req.url.startsWith('/api') && typeof reply.sendFile === 'function') {
      void reply.type('text/html').sendFile('index.html');
      return;
    }
    if (body.statusCode >= 500) this.logger.error(exception instanceof Error ? exception.stack : String(exception));
    void reply.status(body.statusCode).send(body);
  }

  toBody(exception: unknown): ErrorBody {
    if (exception instanceof ThrottlerException) return { statusCode: 429, code: 'RATE_LIMITED', message: 'Muitas tentativas seguidas. Aguarde um minuto.' };
    if (exception instanceof ZodError) return { statusCode: 422, code: 'VALIDATION', message: 'Dados inválidos', errors: exception.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) };
    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      if (exception.code === 'P2025') return { statusCode: 404, code: 'NOT_FOUND', message: 'Recurso não encontrado' };
      if (exception.code === 'P2002') return { statusCode: 409, code: 'CONFLICT', message: 'Registro duplicado' };
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const res = exception.getResponse();
      if (typeof res === 'string') return { statusCode: status, code: 'ERROR', message: res };
      const r = res as { message?: string | string[]; code?: string; details?: Record<string, unknown> };
      return { statusCode: status, code: r.code ?? 'ERROR', message: Array.isArray(r.message) ? r.message.join('; ') : (r.message ?? 'Erro'), ...(r.details ? { details: r.details } : {}) };
    }
    return { statusCode: HttpStatus.INTERNAL_SERVER_ERROR, code: 'INTERNAL', message: 'Erro interno' };
  }
}
```

`apps/api/src/health/health.controller.ts`:
```ts
import { Controller, Get } from '@nestjs/common';
import { Public } from '../auth/auth.decorators';
import { PrismaService } from '../prisma/prisma.service';

@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}
  @Public()
  @Get()
  async get(): Promise<{ ok: true; db: 'up' }> {
    await this.prisma.$queryRaw`SELECT 1`;
    return { ok: true, db: 'up' };
  }
}
```

(`Public` só existe na Task 5 — o typecheck fecha lá. Ordem: escrever tudo desta task, seguir para a Task 5 e só então rodar `typecheck`.)

- [ ] **Step 4: AppModule e main**

`apps/api/src/app.module.ts`:
```ts
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { validateEnv } from './config/env.schema';
import { AllExceptionsFilter } from './common/all-exceptions.filter';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { HealthController } from './health/health.controller';
import { RdModule } from './rd/rd.module';
import { LeadsModule } from './leads/leads.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv, envFilePath: ['../../.env', '.env'] }),
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 300 }]),
    PrismaModule,
    AuthModule,
    RdModule,
    LeadsModule,
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
})
export class AppModule {}
```

`apps/api/src/main.ts`:
```ts
import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import helmet from '@fastify/helmet';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { AppModule } from './app.module';
import type { Env } from './config/env.schema';
import { secretsKeyConfigured } from './common/crypto-secrets';

async function bootstrap(): Promise<void> {
  const tp = process.env.TRUST_PROXY;
  const trustProxy: number | false = tp && /^\d+$/.test(tp) ? Number(tp) : false;
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter({ trustProxy, bodyLimit: 4 * 1024 * 1024 }));
  const config = app.get(ConfigService<Env, true>);
  if (!secretsKeyConfigured()) new Logger('Seguranca').warn('SECRETS_KEY ausente — segredos do RD gravados em TEXTO PURO (só aceitável em dev).');

  const webDist = config.get('WEB_DIST_DIR', { infer: true });
  const servingSpa = !!(webDist && existsSync(webDist));
  await app.register(helmet, servingSpa ? { contentSecurityPolicy: false } : {});
  await app.register(cookie);
  app.enableCors({ origin: [config.get('CORS_ORIGIN', { infer: true })], credentials: true, methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'], allowedHeaders: ['Content-Type', 'Authorization'] });
  app.setGlobalPrefix('api');
  if (servingSpa) await app.register(fastifyStatic, { root: webDist!, wildcard: false });
  app.enableShutdownHooks();
  const port = config.get('PORT', { infer: true });
  await app.listen({ port, host: '0.0.0.0' });
  new Logger('Bootstrap').log(`API em http://localhost:${port}/api`);
}
bootstrap().catch((err) => { console.error('Erro fatal no boot:', err); process.exit(1); });
```

`apps/api/scripts/boot-check.js`:
```js
#!/usr/bin/env node
// Compila o AppModule inteiro sobre o dist (fiação do Nest) sem conectar em nada.
const path = require('path');
const ENV_FAKE = { NODE_ENV: 'test', DATABASE_URL: 'postgresql://boot:boot@127.0.0.1:1/boot', JWT_ACCESS_SECRET: 'boot-check-secret-com-mais-de-16-chars', SECRETS_KEY: 'boot' };
for (const [k, v] of Object.entries(ENV_FAKE)) if (process.env[k] === undefined) process.env[k] = v;
(async () => {
  const { Test } = require('@nestjs/testing');
  const { AppModule } = require(path.join(__dirname, '..', 'dist', 'app.module'));
  const t0 = Date.now();
  const ref = await Test.createTestingModule({ imports: [AppModule] }).compile();
  await ref.close();
  console.log(`boot-check OK em ${Date.now() - t0} ms`);
})().catch((e) => { console.error('boot-check FALHOU:', e && e.message ? e.message : e); process.exit(1); });
```

- [ ] **Step 5: Rodar o teste da cifra**

Run: `corepack pnpm --filter @rd/api test -- crypto`
Expected: 3 testes PASS.

- [ ] **Step 6: Commit** (o typecheck completo fecha na Task 5)

```bash
```

---

### Task 5: API — autenticação (registrar conta, login, refresh, logout, me)

**Files:**
- Create: `apps/api/src/auth/auth.types.ts`, `auth.decorators.ts`, `password.service.ts`, `token.service.ts`, `jwt-auth.guard.ts`, `auth.service.ts`, `auth.service.spec.ts`, `auth.controller.ts`, `auth.module.ts`

- [ ] **Step 1: Teste do service (falha primeiro)**

`apps/api/src/auth/auth.service.spec.ts`:
```ts
import { describe, expect, it, vi } from 'vitest';
import { AuthService } from './auth.service';
import { PasswordService } from './password.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { TokenService } from './token.service';

function make() {
  const users = new Map<string, { id: string; accountId: string; name: string; email: string; passwordHash: string; role: 'admin'; account: { name: string } }>();
  const prisma = {
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma)),
    account: { create: vi.fn(async ({ data }: { data: { name: string } }) => ({ id: 'acc-1', name: data.name })) },
    user: {
      findUnique: vi.fn(async ({ where }: { where: { email?: string; id?: string } }) => [...users.values()].find((u) => u.email === where.email || u.id === where.id) ?? null),
      create: vi.fn(async ({ data }: { data: { accountId: string; name: string; email: string; passwordHash: string } }) => { const u = { id: 'u-1', role: 'admin' as const, account: { name: 'Acme' }, ...data }; users.set(u.id, u); return u; }),
      update: vi.fn(async () => ({})),
    },
  } as unknown as PrismaService;
  const tokens = { signAccess: vi.fn(() => 'access'), issueRefresh: vi.fn(async () => 'refresh'), rotateRefresh: vi.fn(), revoke: vi.fn() } as unknown as TokenService;
  return { svc: new AuthService(prisma, new PasswordService(), tokens), prisma };
}

describe('AuthService', () => {
  it('register cria conta + admin com senha em argon2 e devolve sessão', async () => {
    const { svc, prisma } = make();
    const r = await svc.register({ accountName: 'Acme', name: 'Ana', email: 'ana@acme.com', password: 'senha-forte-10' });
    expect(r.accessToken).toBe('access');
    expect(r.user).toMatchObject({ email: 'ana@acme.com', role: 'admin', accountId: 'acc-1' });
    const created = (prisma.user.create as ReturnType<typeof vi.fn>).mock.calls[0]![0].data;
    expect(created.passwordHash).toMatch(/^\$argon2id\$/);
  });

  it('login com senha errada → 401 sem revelar se o e-mail existe', async () => {
    const { svc } = make();
    await svc.register({ accountName: 'Acme', name: 'Ana', email: 'ana@acme.com', password: 'senha-forte-10' });
    await expect(svc.login({ email: 'ana@acme.com', password: 'errada-errada' })).rejects.toThrow('E-mail ou senha inválidos');
    await expect(svc.login({ email: 'ninguem@acme.com', password: 'x' })).rejects.toThrow('E-mail ou senha inválidos');
  });
});
```

Run: `corepack pnpm --filter @rd/api test -- auth`
Expected: FAIL — módulos ausentes.

- [ ] **Step 2: Tipos, decorators, password, token**

`apps/api/src/auth/auth.types.ts`:
```ts
export interface JwtPayload { sub: string; accountId: string; role: 'admin' | 'viewer' }
export interface AuthUser { id: string; name: string; email: string; role: 'admin' | 'viewer'; accountId: string; accountName: string }
```

`apps/api/src/auth/auth.decorators.ts`:
```ts
import { SetMetadata, createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { AuthUser } from './auth.types';

export const IS_PUBLIC_KEY = 'isPublic';
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true);
export const ADMIN_KEY = 'requireAdmin';
export const RequireAdmin = (): MethodDecorator & ClassDecorator => SetMetadata(ADMIN_KEY, true);

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthUser => {
  return ctx.switchToHttp().getRequest<FastifyRequest & { user: AuthUser }>().user;
});
```

`apps/api/src/auth/password.service.ts`:
```ts
import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';

@Injectable()
export class PasswordService {
  hash(plain: string): Promise<string> { return argon2.hash(plain, { type: argon2.argon2id }); }
  async verify(hash: string, plain: string): Promise<boolean> { try { return await argon2.verify(hash, plain); } catch { return false; } }
}
```

`apps/api/src/auth/token.service.ts`:
```ts
import { createHash, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { UnauthorizedError } from '../common/errors';
import type { Env } from '../config/env.schema';
import { PrismaService } from '../prisma/prisma.service';
import type { JwtPayload } from './auth.types';

function durationToMs(v: string): number {
  const m = /^(\d+)\s*([smhd])$/.exec(v.trim());
  if (!m) throw new Error(`Duração inválida: ${v}`);
  return Number(m[1]) * { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as 's' | 'm' | 'h' | 'd'];
}

@Injectable()
export class TokenService {
  constructor(private readonly jwt: JwtService, private readonly config: ConfigService<Env, true>, private readonly prisma: PrismaService) {}

  signAccess(p: JwtPayload): string {
    return this.jwt.sign(p, { secret: this.config.get('JWT_ACCESS_SECRET', { infer: true }), expiresIn: this.config.get('JWT_ACCESS_TTL', { infer: true }) });
  }
  verifyAccess(token: string): JwtPayload {
    try { return this.jwt.verify<JwtPayload>(token, { secret: this.config.get('JWT_ACCESS_SECRET', { infer: true }) }); }
    catch { throw new UnauthorizedError('Token inválido ou expirado'); }
  }
  refreshMaxAgeMs(): number { return durationToMs(this.config.get('JWT_REFRESH_TTL', { infer: true })); }
  private hash(raw: string): string { return createHash('sha256').update(raw).digest('hex'); }

  async issueRefresh(userId: string): Promise<string> {
    const raw = randomBytes(48).toString('hex');
    await this.prisma.refreshToken.create({ data: { userId, tokenHash: this.hash(raw), expiresAt: new Date(Date.now() + this.refreshMaxAgeMs()) } });
    return raw;
  }

  /** Rotação: revoga o atual e emite novo; reuso de token revogado derruba a família toda. */
  async rotateRefresh(raw: string): Promise<{ userId: string; refresh: string }> {
    const tokenHash = this.hash(raw);
    const existing = await this.prisma.refreshToken.findUnique({ where: { tokenHash } });
    if (!existing || existing.expiresAt < new Date()) throw new UnauthorizedError('Sessão expirada');
    if (existing.revokedAt) {
      await this.prisma.refreshToken.updateMany({ where: { userId: existing.userId, revokedAt: null }, data: { revokedAt: new Date() } });
      throw new UnauthorizedError('Sessão inválida');
    }
    const res = await this.prisma.refreshToken.updateMany({ where: { id: existing.id, revokedAt: null }, data: { revokedAt: new Date() } });
    if (res.count === 0) throw new UnauthorizedError('Sessão inválida');
    return { userId: existing.userId, refresh: await this.issueRefresh(existing.userId) };
  }

  async revoke(raw: string | undefined): Promise<void> {
    if (!raw) return;
    await this.prisma.refreshToken.updateMany({ where: { tokenHash: this.hash(raw), revokedAt: null }, data: { revokedAt: new Date() } });
  }
}
```

- [ ] **Step 3: Guard, service, controller, módulo**

`apps/api/src/auth/jwt-auth.guard.ts`:
```ts
import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { ForbiddenError, UnauthorizedError } from '../common/errors';
import { PrismaService } from '../prisma/prisma.service';
import { ADMIN_KEY, IS_PUBLIC_KEY } from './auth.decorators';
import type { AuthUser } from './auth.types';
import { TokenService } from './token.service';

/** Fail-closed: toda rota exige Bearer, salvo @Public(). @RequireAdmin() exige role admin. */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly tokens: TokenService, private readonly prisma: PrismaService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) return true;
    const req = ctx.switchToHttp().getRequest<FastifyRequest & { user?: AuthUser }>();
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw new UnauthorizedError();
    const payload = this.tokens.verifyAccess(header.slice(7));
    const user = await this.prisma.user.findUnique({ where: { id: payload.sub }, include: { account: { select: { name: true } } } });
    if (!user) throw new UnauthorizedError('Sessão inválida');
    req.user = { id: user.id, name: user.name, email: user.email, role: user.role, accountId: user.accountId, accountName: user.account.name };
    if (this.reflector.getAllAndOverride<boolean>(ADMIN_KEY, targets) && user.role !== 'admin') throw new ForbiddenError('Só administradores');
    return true;
  }
}
```

`apps/api/src/auth/auth.service.ts`:
```ts
import { Injectable } from '@nestjs/common';
import type { AuthResponse, LoginDto, RegisterDto, SessionUser } from '@rd/shared';
import { UnauthorizedError } from '../common/errors';
import { PrismaService } from '../prisma/prisma.service';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';

export interface AuthResult extends AuthResponse { refresh: string }
type UserRow = { id: string; name: string; email: string; role: 'admin' | 'viewer'; accountId: string; account: { name: string } };

@Injectable()
export class AuthService {
  constructor(private readonly prisma: PrismaService, private readonly passwords: PasswordService, private readonly tokens: TokenService) {}

  private view(u: UserRow): SessionUser { return { id: u.id, name: u.name, email: u.email, role: u.role, accountId: u.accountId, accountName: u.account.name }; }

  private async session(u: UserRow): Promise<AuthResult> {
    return { accessToken: this.tokens.signAccess({ sub: u.id, accountId: u.accountId, role: u.role }), refresh: await this.tokens.issueRefresh(u.id), user: this.view(u) };
  }

  async register(dto: RegisterDto): Promise<AuthResult> {
    const passwordHash = await this.passwords.hash(dto.password);
    const user = await this.prisma.$transaction(async (tx) => {
      const account = await tx.account.create({ data: { name: dto.accountName } });
      return tx.user.create({ data: { accountId: account.id, name: dto.name, email: dto.email, passwordHash, role: 'admin' }, include: { account: { select: { name: true } } } });
    });
    return this.session(user as UserRow);
  }

  async login(dto: LoginDto): Promise<AuthResult> {
    const user = await this.prisma.user.findUnique({ where: { email: dto.email }, include: { account: { select: { name: true } } } });
    // Mesma mensagem nos dois casos: não revela se o e-mail existe.
    if (!user || !(await this.passwords.verify(user.passwordHash, dto.password))) throw new UnauthorizedError('E-mail ou senha inválidos');
    await this.prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    return this.session(user as UserRow);
  }

  async refresh(raw: string): Promise<AuthResult> {
    const { userId, refresh } = await this.tokens.rotateRefresh(raw);
    const user = await this.prisma.user.findUnique({ where: { id: userId }, include: { account: { select: { name: true } } } });
    if (!user) throw new UnauthorizedError('Sessão inválida');
    return { accessToken: this.tokens.signAccess({ sub: user.id, accountId: user.accountId, role: user.role }), refresh, user: this.view(user as UserRow) };
  }

  logout(raw: string | undefined): Promise<void> { return this.tokens.revoke(raw); }
}
```

`apps/api/src/auth/auth.controller.ts`:
```ts
import { Body, Controller, Get, Post, Req, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';
import { loginSchema, registerSchema, type AuthResponse, type LoginDto, type RegisterDto, type SessionUser } from '@rd/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import type { Env } from '../config/env.schema';
import { AuthService, type AuthResult } from './auth.service';
import { CurrentUser, Public } from './auth.decorators';
import type { AuthUser } from './auth.types';
import { TokenService } from './token.service';

const COOKIE = 'refresh_token';
const PATH = '/api/auth';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService, private readonly tokens: TokenService, private readonly config: ConfigService<Env, true>) {}

  private respond(reply: FastifyReply, r: AuthResult): AuthResponse {
    reply.setCookie(COOKIE, r.refresh, { httpOnly: true, secure: this.config.get('NODE_ENV', { infer: true }) === 'production', sameSite: 'strict', path: PATH, maxAge: Math.floor(this.tokens.refreshMaxAgeMs() / 1000) });
    return { accessToken: r.accessToken, user: r.user };
  }

  @Public() @Throttle({ default: { limit: 5, ttl: 60_000 } }) @Post('register')
  async register(@Body(new ZodValidationPipe(registerSchema)) dto: RegisterDto, @Res({ passthrough: true }) reply: FastifyReply): Promise<AuthResponse> {
    return this.respond(reply, await this.auth.register(dto));
  }

  @Public() @Throttle({ default: { limit: 10, ttl: 60_000 } }) @Post('login')
  async login(@Body(new ZodValidationPipe(loginSchema)) dto: LoginDto, @Res({ passthrough: true }) reply: FastifyReply): Promise<AuthResponse> {
    return this.respond(reply, await this.auth.login(dto));
  }

  @Public() @Throttle({ default: { limit: 30, ttl: 60_000 } }) @Post('refresh')
  async refresh(@Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply): Promise<AuthResponse> {
    return this.respond(reply, await this.auth.refresh(req.cookies?.[COOKIE] ?? ''));
  }

  @Public() @Post('logout')
  async logout(@Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply): Promise<{ ok: true }> {
    await this.auth.logout(req.cookies?.[COOKIE]);
    reply.clearCookie(COOKIE, { path: PATH });
    return { ok: true };
  }

  @Get('me')
  me(@CurrentUser() user: AuthUser): SessionUser { return user; }
}
```

`apps/api/src/auth/auth.module.ts`:
```ts
import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';

@Module({
  imports: [JwtModule.register({})],
  controllers: [AuthController],
  providers: [AuthService, PasswordService, TokenService, JwtAuthGuard],
  exports: [TokenService, JwtAuthGuard],
})
export class AuthModule {}
```

- [ ] **Step 4: Stubs vazios de RdModule/LeadsModule** para o AppModule compilar (preenchidos nas Tasks 6–8)

`apps/api/src/rd/rd.module.ts`:
```ts
import { Module } from '@nestjs/common';
@Module({})
export class RdModule {}
```
`apps/api/src/leads/leads.module.ts`:
```ts
import { Module } from '@nestjs/common';
@Module({})
export class LeadsModule {}
```

- [ ] **Step 5: Testes + typecheck + boot + smoke**

```bash
corepack pnpm --filter @rd/api test
corepack pnpm --filter @rd/api typecheck
corepack pnpm --filter @rd/api test:boot
```
Expected: todos PASS; `boot-check OK`.

Smoke (com `corepack pnpm --filter @rd/api dev` rodando em outro terminal):
```bash
curl -s -X POST localhost:22501/api/auth/register -H 'content-type: application/json' -d '{"accountName":"Teste","name":"Ana","email":"ana@teste.com","password":"senha-forte-10"}'
```
Expected: JSON com `accessToken` e `user.role = "admin"`; `GET /api/health` → `{"ok":true,"db":"up"}`.

- [ ] **Step 6: Commit**

```bash
```

---

### Task 6: API — `RdClient` (OAuth, refresh automático, backoff 429)

**Files:**
- Create: `apps/api/src/rd/rd-client.ts`, `apps/api/src/rd/rd-client.spec.ts`

- [ ] **Step 1: Teste (falha primeiro)**

`apps/api/src/rd/rd-client.spec.ts`:
```ts
import { describe, expect, it, vi } from 'vitest';
import { RdClient, type RdTokens } from './rd-client';

function res(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

function make(tokens: RdTokens, fetchImpl: typeof fetch) {
  const saved: RdTokens[] = [];
  const client = new RdClient({ baseUrl: 'https://rd.test', clientId: 'cid', clientSecret: 'sec', tokens, onTokens: async (t) => { saved.push(t); }, fetchImpl, sleep: async () => {} });
  return { client, saved };
}

describe('RdClient', () => {
  it('renova o access token antes de chamar quando faltar < 1h', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(res(200, { access_token: 'novo', refresh_token: 'r2', expires_in: 86400 }))
      .mockResolvedValueOnce(res(200, { segmentations: [] }));
    const { client, saved } = make({ accessToken: 'velho', refreshToken: 'r1', expiresAt: new Date(Date.now() + 10 * 60_000) }, fetchImpl);
    await client.get('/platform/segmentations');
    expect(fetchImpl.mock.calls[0]![0]).toContain('/auth/token?token_by=refresh_token');
    expect(saved[0]).toMatchObject({ accessToken: 'novo', refreshToken: 'r2' });
    expect((fetchImpl.mock.calls[1]![1] as RequestInit).headers).toMatchObject({ Authorization: 'Bearer novo' });
  });

  it('em 429 espera e repete; em 401 após refresh lança RdProviderError 401', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(res(429, {}, { 'retry-after': '1' }))
      .mockResolvedValueOnce(res(200, { ok: 1 }));
    const { client } = make({ accessToken: 'a', refreshToken: 'r', expiresAt: new Date(Date.now() + 5 * 3_600_000) }, fetchImpl);
    expect(await client.get('/x')).toEqual({ ok: 1 });

    const f2 = vi.fn().mockResolvedValueOnce(res(401, {})).mockResolvedValueOnce(res(200, { access_token: 'n', refresh_token: 'r', expires_in: 86400 })).mockResolvedValueOnce(res(401, {}));
    const { client: c2 } = make({ accessToken: 'a', refreshToken: 'r', expiresAt: new Date(Date.now() + 5 * 3_600_000) }, f2);
    await expect(c2.get('/x')).rejects.toMatchObject({ providerStatus: 401 });
  });

  it('exchangeCode troca o code por tokens', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(res(200, { access_token: 'a', refresh_token: 'r', expires_in: 86400 }));
    const t = await RdClient.exchangeCode({ baseUrl: 'https://rd.test', clientId: 'cid', clientSecret: 'sec', code: 'c0de', fetchImpl });
    expect(t.accessToken).toBe('a');
    expect(JSON.parse((fetchImpl.mock.calls[0]![1] as RequestInit).body as string)).toEqual({ client_id: 'cid', client_secret: 'sec', code: 'c0de' });
  });
});
```

Run: `corepack pnpm --filter @rd/api test -- rd-client`
Expected: FAIL — módulo ausente.

- [ ] **Step 2: Implementar**

`apps/api/src/rd/rd-client.ts`:
```ts
import { RdProviderError } from '../common/errors';

export interface RdTokens { accessToken: string; refreshToken: string; expiresAt: Date }
export interface RdClientOpts {
  baseUrl: string; clientId: string; clientSecret: string; tokens: RdTokens;
  onTokens: (t: RdTokens) => Promise<void>;
  fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void>;
}
interface TokenBody { access_token: string; refresh_token: string; expires_in: number }

const ONE_HOUR = 3_600_000;
const MAX_RETRIES = 5;

/**
 * Cliente HTTP do RD Station Marketing: Bearer + refresh automático (token vive
 * 24 h; renova quando faltar < 1 h) + backoff em 429 (1s,2s,4s… máx 60s, 5x).
 * 401 depois de um refresh forçado → RdProviderError(401) → quem chama marca a
 * conexão como `reauth_required`.
 */
export class RdClient {
  private tokens: RdTokens;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: RdClientOpts) {
    this.tokens = opts.tokens;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  static authorizeUrl(baseUrl: string, clientId: string, redirectUri: string, state: string): string {
    const u = new URL('/auth/dialog', baseUrl);
    u.searchParams.set('client_id', clientId);
    u.searchParams.set('redirect_uri', redirectUri);
    u.searchParams.set('state', state);
    return u.toString();
  }

  static async exchangeCode(p: { baseUrl: string; clientId: string; clientSecret: string; code: string; fetchImpl?: typeof fetch }): Promise<RdTokens> {
    return RdClient.token(p.baseUrl, 'code', { client_id: p.clientId, client_secret: p.clientSecret, code: p.code }, p.fetchImpl ?? fetch);
  }

  private static async token(baseUrl: string, by: 'code' | 'refresh_token', body: Record<string, string>, f: typeof fetch): Promise<RdTokens> {
    const r = await f(`${baseUrl}/auth/token?token_by=${by}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) throw new RdProviderError(`RD recusou o token (${r.status})`, r.status);
    const t = (await r.json()) as TokenBody;
    return { accessToken: t.access_token, refreshToken: t.refresh_token, expiresAt: new Date(Date.now() + t.expires_in * 1000) };
  }

  private async refresh(): Promise<void> {
    this.tokens = await RdClient.token(this.opts.baseUrl, 'refresh_token', { client_id: this.opts.clientId, client_secret: this.opts.clientSecret, refresh_token: this.tokens.refreshToken }, this.fetchImpl);
    await this.opts.onTokens(this.tokens);
  }

  async get<T>(path: string, query: Record<string, string | number | undefined> = {}): Promise<T> {
    const u = new URL(path, this.opts.baseUrl);
    for (const [k, v] of Object.entries(query)) if (v !== undefined) u.searchParams.set(k, String(v));
    return this.request<T>(u.toString(), { method: 'GET' });
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>(new URL(path, this.opts.baseUrl).toString(), { method: 'POST', body: JSON.stringify(body) });
  }

  private async request<T>(url: string, init: RequestInit, refreshed = false, attempt = 0): Promise<T> {
    if (this.tokens.expiresAt.getTime() - Date.now() < ONE_HOUR && !refreshed) { await this.refresh(); refreshed = true; }
    const r = await this.fetchImpl(url, { ...init, headers: { 'content-type': 'application/json', Authorization: `Bearer ${this.tokens.accessToken}`, ...(init.headers ?? {}) } });
    if (r.status === 401 && !refreshed) { await this.refresh(); return this.request<T>(url, init, true, attempt); }
    if (r.status === 429 && attempt < MAX_RETRIES) {
      const ra = Number(r.headers.get('retry-after'));
      await this.sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : Math.min(60_000, 1000 * 2 ** attempt));
      return this.request<T>(url, init, refreshed, attempt + 1);
    }
    if (!r.ok) throw new RdProviderError(`RD respondeu ${r.status}`, r.status);
    return (await r.json()) as T;
  }
}
```

- [ ] **Step 3: Rodar**

Run: `corepack pnpm --filter @rd/api test -- rd-client`
Expected: 3 PASS.

- [ ] **Step 4: Commit**

```bash
```

---

### Task 7: API — conexão RD (credenciais, OAuth callback, segmentações)

**Files:**
- Create: `apps/api/src/rd/rd-connection.service.ts`, `rd-connection.controller.ts`
- Modify: `apps/api/src/rd/rd.module.ts`

- [ ] **Step 1: Service**

`apps/api/src/rd/rd-connection.service.ts`:
```ts
import { createHmac, timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { RdConnectionView, RdCredentialsDto, RdSegmentation, RdSegmentationDto } from '@rd/shared';
import { BusinessError, NotFoundError, RdProviderError } from '../common/errors';
import { decryptSecret, encryptSecret } from '../common/crypto-secrets';
import type { Env } from '../config/env.schema';
import { PrismaService } from '../prisma/prisma.service';
import { RdClient, type RdTokens } from './rd-client';

@Injectable()
export class RdConnectionService {
  constructor(private readonly prisma: PrismaService, private readonly config: ConfigService<Env, true>) {}

  private get baseUrl(): string { return this.config.get('RD_API_BASE_URL', { infer: true }); }
  private get redirectUri(): string { return `${this.config.get('APP_URL', { infer: true })}/api/rd/callback`; }

  /** `state` assinado com o JWT secret: amarra o callback à conta que iniciou. */
  private signState(accountId: string): string {
    const sig = createHmac('sha256', this.config.get('JWT_ACCESS_SECRET', { infer: true })).update(accountId).digest('hex');
    return `${accountId}.${sig}`;
  }
  private verifyState(state: string): string {
    const [accountId, sig] = state.split('.');
    if (!accountId || !sig) throw new BusinessError('state inválido');
    const esperado = createHmac('sha256', this.config.get('JWT_ACCESS_SECRET', { infer: true })).update(accountId).digest('hex');
    if (sig.length !== esperado.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(esperado))) throw new BusinessError('state inválido');
    return accountId;
  }

  async view(accountId: string): Promise<RdConnectionView> {
    const c = await this.prisma.rdConnection.findUnique({ where: { accountId } });
    if (!c) return { status: 'pending', hasClientSecret: false, clientId: null, segmentationId: null, segmentationName: null, lastFullSyncAt: null, lastError: null };
    return { status: c.status, hasClientSecret: !!c.clientSecret, clientId: c.clientId, segmentationId: c.segmentationId, segmentationName: c.segmentationName, lastFullSyncAt: c.lastFullSyncAt?.toISOString() ?? null, lastError: c.lastError };
  }

  async saveCredentials(accountId: string, dto: RdCredentialsDto): Promise<RdConnectionView> {
    await this.prisma.rdConnection.upsert({
      where: { accountId },
      create: { accountId, clientId: dto.clientId, clientSecret: encryptSecret(dto.clientSecret), status: 'pending' },
      update: { clientId: dto.clientId, clientSecret: encryptSecret(dto.clientSecret), status: 'pending', accessToken: null, refreshToken: null, expiresAt: null, lastError: null },
    });
    return this.view(accountId);
  }

  async authorizeUrl(accountId: string): Promise<string> {
    const c = await this.prisma.rdConnection.findUnique({ where: { accountId } });
    if (!c) throw new NotFoundError('Informe client_id e client_secret antes de autorizar');
    return RdClient.authorizeUrl(this.baseUrl, c.clientId, this.redirectUri, this.signState(accountId));
  }

  /** Callback do RD: troca o code, grava tokens cifrados, status=authorized. Devolve a URL do front. */
  async handleCallback(code: string, state: string): Promise<string> {
    const accountId = this.verifyState(state);
    const c = await this.prisma.rdConnection.findUnique({ where: { accountId } });
    if (!c) throw new NotFoundError();
    try {
      const t = await RdClient.exchangeCode({ baseUrl: this.baseUrl, clientId: c.clientId, clientSecret: decryptSecret(c.clientSecret), code });
      await this.saveTokens(accountId, t, 'authorized');
    } catch (e) {
      await this.prisma.rdConnection.update({ where: { accountId }, data: { status: 'error', lastError: e instanceof Error ? e.message : String(e) } });
    }
    return `${this.config.get('APP_URL', { infer: true })}/conectar`;
  }

  private async saveTokens(accountId: string, t: RdTokens, status?: 'authorized' | 'active'): Promise<void> {
    await this.prisma.rdConnection.update({ where: { accountId }, data: { accessToken: encryptSecret(t.accessToken), refreshToken: encryptSecret(t.refreshToken), expiresAt: t.expiresAt, lastError: null, ...(status ? { status } : {}) } });
  }

  /** Client autenticado da conta. 401 definitivo → marca reauth_required e relança. */
  async client(accountId: string): Promise<RdClient> {
    const c = await this.prisma.rdConnection.findUnique({ where: { accountId } });
    if (!c?.accessToken || !c.refreshToken || !c.expiresAt) throw new BusinessError('Conta ainda não autorizada no RD');
    return new RdClient({
      baseUrl: this.baseUrl, clientId: c.clientId, clientSecret: decryptSecret(c.clientSecret),
      tokens: { accessToken: decryptSecret(c.accessToken), refreshToken: decryptSecret(c.refreshToken), expiresAt: c.expiresAt },
      onTokens: (t) => this.saveTokens(accountId, t),
    });
  }

  async marcarErro(accountId: string, e: unknown): Promise<void> {
    const reauth = e instanceof RdProviderError && e.providerStatus === 401;
    await this.prisma.rdConnection.update({ where: { accountId }, data: { status: reauth ? 'reauth_required' : 'error', lastError: (e instanceof Error ? e.message : String(e)).slice(0, 500) } });
  }

  async segmentations(accountId: string): Promise<RdSegmentation[]> {
    const client = await this.client(accountId);
    try {
      const r = await client.get<{ segmentations: Array<{ id: number | string; name: string; standard: boolean }> }>('/platform/segmentations');
      return r.segmentations.map((s) => ({ id: String(s.id), name: s.name, standard: s.standard }));
    } catch (e) { await this.marcarErro(accountId, e); throw e; }
  }

  async chooseSegmentation(accountId: string, dto: RdSegmentationDto): Promise<RdConnectionView> {
    await this.prisma.rdConnection.update({ where: { accountId }, data: { segmentationId: dto.segmentationId, segmentationName: dto.segmentationName, status: 'active' } });
    return this.view(accountId);
  }
}
```

- [ ] **Step 2: Controller + módulo**

`apps/api/src/rd/rd-connection.controller.ts`:
```ts
import { Body, Controller, Get, Post, Query, Res } from '@nestjs/common';
import { rdCredentialsSchema, rdSegmentationSchema, type RdConnectionView, type RdCredentialsDto, type RdSegmentation, type RdSegmentationDto } from '@rd/shared';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { CurrentUser, Public, RequireAdmin } from '../auth/auth.decorators';
import type { AuthUser } from '../auth/auth.types';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { RdConnectionService } from './rd-connection.service';

const callbackSchema = z.object({ code: z.string().min(1), state: z.string().min(1) });

@Controller('rd')
export class RdConnectionController {
  constructor(private readonly svc: RdConnectionService) {}

  @Get('connection') connection(@CurrentUser() u: AuthUser): Promise<RdConnectionView> { return this.svc.view(u.accountId); }

  @RequireAdmin() @Post('credentials')
  credentials(@CurrentUser() u: AuthUser, @Body(new ZodValidationPipe(rdCredentialsSchema)) dto: RdCredentialsDto): Promise<RdConnectionView> { return this.svc.saveCredentials(u.accountId, dto); }

  /** O front abre esta URL (window.location) — o RD redireciona de volta p/ /api/rd/callback. */
  @RequireAdmin() @Get('authorize-url')
  async authorizeUrl(@CurrentUser() u: AuthUser): Promise<{ url: string }> { return { url: await this.svc.authorizeUrl(u.accountId) }; }

  @Public() @Get('callback')
  async callback(@Query(new ZodValidationPipe(callbackSchema)) q: { code: string; state: string }, @Res() reply: FastifyReply): Promise<void> {
    const to = await this.svc.handleCallback(q.code, q.state);
    void reply.redirect(to, 302);
  }

  @RequireAdmin() @Get('segmentations') segmentations(@CurrentUser() u: AuthUser): Promise<RdSegmentation[]> { return this.svc.segmentations(u.accountId); }

  @RequireAdmin() @Post('segmentation')
  segmentation(@CurrentUser() u: AuthUser, @Body(new ZodValidationPipe(rdSegmentationSchema)) dto: RdSegmentationDto): Promise<RdConnectionView> { return this.svc.chooseSegmentation(u.accountId, dto); }
}
```

`apps/api/src/rd/rd.module.ts` (substitui o stub):
```ts
import { Module } from '@nestjs/common';
import { RdConnectionController } from './rd-connection.controller';
import { RdConnectionService } from './rd-connection.service';
import { RdSyncController } from './rd-sync.controller';
import { RdSyncService } from './rd-sync.service';

@Module({
  controllers: [RdConnectionController, RdSyncController],
  providers: [RdConnectionService, RdSyncService],
  exports: [RdConnectionService],
})
export class RdModule {}
```
(`RdSyncService`/`RdSyncController` nascem na Task 8 — criar agora arquivos mínimos ou fazer as Tasks 7 e 8 no mesmo typecheck.)

- [ ] **Step 3: Typecheck após a Task 8, commit desta**

```bash
```

---

### Task 8: API — carga inicial (segmentação → contato → funil → eventos)

**Files:**
- Create: `apps/api/src/rd/rd-sync.service.ts`, `rd-sync.service.spec.ts`, `rd-sync.controller.ts`, `rd-mapper.ts`

- [ ] **Step 1: Teste do mapper e da paginação retomável (falha primeiro)**

`apps/api/src/rd/rd-sync.service.spec.ts`:
```ts
import { describe, expect, it, vi } from 'vitest';
import { mapContact } from './rd-mapper';
import { RdSyncService } from './rd-sync.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { RdConnectionService } from './rd-connection.service';

describe('mapContact', () => {
  it('extrai campos padrão, custom (cf_*), funil e eventos', () => {
    const lead = mapContact(
      { uuid: 'u1', name: 'Ana', email: 'a@x.com', personal_phone: '11 9', city: 'Londrina', state: 'PR', tags: ['vip'], cf_origem: 'insta', job_title: 'CEO' },
      { lifecycle_stage: 'Lead', opportunity: true, fit: 'A', interest: 70 },
      [{ event_type: 'CONVERSION', event_identifier: 'forms - consultoria', event_timestamp: '2026-09-01T10:00:00Z', payload: {} }, { event_type: 'CONVERSION', event_identifier: 'whatsapp', event_timestamp: '2026-09-20T10:00:00Z', payload: {} }],
    );
    expect(lead.lead).toMatchObject({ rdUuid: 'u1', name: 'Ana', phone: '11 9', city: 'Londrina', state: 'PR', tags: ['vip'], jobTitle: 'CEO', lifecycleStage: 'Lead', opportunity: true, fit: 'A', interest: 70, conversionsCount: 2, customFields: { cf_origem: 'insta' } });
    expect(lead.lead.firstConversionAt?.toISOString()).toBe('2026-09-01T10:00:00.000Z');
    expect(lead.lead.lastConversionAt?.toISOString()).toBe('2026-09-20T10:00:00.000Z');
    expect(lead.events).toHaveLength(2);
  });
});

describe('RdSyncService.runFull', () => {
  it('pagina a segmentação, grava cursor por página e retoma do cursor', async () => {
    const pages: Record<number, string[]> = { 1: ['a', 'b'], 2: ['c'], 3: [] };
    const client = {
      get: vi.fn(async (path: string, q?: { page?: number }) => {
        if (path.includes('/segmentations/')) return { contacts: (pages[q!.page!] ?? []).map((uuid) => ({ uuid, name: uuid })) };
        if (path.endsWith('/funnels/default')) return { lifecycle_stage: 'Lead', opportunity: false, fit: null, interest: null };
        if (path.endsWith('/events')) return { events: [] };
        return { uuid: path.split('uuid:')[1], name: 'n', tags: [] };
      }),
    };
    const runs: Array<{ cursor: number }> = [];
    const prisma = {
      rdConnection: { findUnique: vi.fn(async () => ({ accountId: 'acc', segmentationId: '9', status: 'active' })), update: vi.fn() },
      syncRun: { create: vi.fn(async () => ({ id: 'run-1' })), update: vi.fn(async ({ data }: { data: { cursor?: number } }) => { if (data.cursor !== undefined) runs.push({ cursor: data.cursor }); }), findFirst: vi.fn(async () => null) },
      lead: { upsert: vi.fn(async () => ({ id: 'l' })) },
      leadEvent: { createMany: vi.fn(async () => ({ count: 0 })) },
    } as unknown as PrismaService;
    const conn = { client: vi.fn(async () => client), marcarErro: vi.fn() } as unknown as RdConnectionService;
    const svc = new RdSyncService(prisma, conn);
    await svc.runFull('acc', { fromCursor: 0 });
    expect(runs.map((r) => r.cursor)).toEqual([1, 2]);
    expect((prisma.lead.upsert as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(3);

    (prisma.lead.upsert as ReturnType<typeof vi.fn>).mockClear();
    await svc.runFull('acc', { fromCursor: 1 }); // retoma: só a página 2
    expect((prisma.lead.upsert as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });
});
```

Run: `corepack pnpm --filter @rd/api test -- rd-sync`
Expected: FAIL — módulos ausentes.

- [ ] **Step 2: Mapper**

`apps/api/src/rd/rd-mapper.ts`:
```ts
import type { Prisma } from '@prisma/client';

export interface RdContact { uuid: string; name?: string | null; email?: string | null; personal_phone?: string | null; mobile_phone?: string | null; city?: string | null; state?: string | null; country?: string | null; job_title?: string | null; website?: string | null; tags?: string[]; created_at?: string; [k: string]: unknown }
export interface RdFunnel { lifecycle_stage?: string | null; opportunity?: boolean | null; fit?: string | null; interest?: number | null }
export interface RdEvent { event_type: 'CONVERSION' | 'OPPORTUNITY'; event_identifier: string; event_timestamp: string; payload?: Record<string, unknown> }

const PADRAO = new Set(['uuid', 'name', 'email', 'personal_phone', 'mobile_phone', 'city', 'state', 'country', 'job_title', 'website', 'tags', 'created_at', 'links', 'extra_emails', 'legal_bases', 'bio', 'birthdate', 'twitter', 'facebook', 'linkedin']);

export function mapContact(c: RdContact, funnel: RdFunnel | null, events: RdEvent[]): { lead: Omit<Prisma.LeadUncheckedCreateInput, 'accountId'>; events: Array<{ type: 'CONVERSION' | 'OPPORTUNITY'; identifier: string; occurredAt: Date; payload: Prisma.InputJsonValue }> } {
  const customFields: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(c)) if (!PADRAO.has(k)) customFields[k] = v;
  const conv = events.filter((e) => e.event_type === 'CONVERSION').map((e) => new Date(e.event_timestamp)).sort((a, b) => a.getTime() - b.getTime());
  return {
    lead: {
      rdUuid: c.uuid, name: c.name ?? null, email: c.email ?? null, phone: c.personal_phone ?? c.mobile_phone ?? null,
      city: c.city ?? null, state: c.state ?? null, country: c.country ?? null, jobTitle: c.job_title ?? null, website: c.website ?? null,
      tags: c.tags ?? [], lifecycleStage: funnel?.lifecycle_stage ?? null, opportunity: funnel?.opportunity ?? false, fit: funnel?.fit ?? null, interest: funnel?.interest ?? null,
      conversionsCount: conv.length, firstConversionAt: conv[0] ?? null, lastConversionAt: conv[conv.length - 1] ?? null,
      rdCreatedAt: c.created_at ? new Date(c.created_at) : null, customFields: customFields as Prisma.InputJsonValue, raw: c as Prisma.InputJsonValue, syncedAt: new Date(),
    },
    events: events.map((e) => ({ type: e.event_type, identifier: e.event_identifier, occurredAt: new Date(e.event_timestamp), payload: (e.payload ?? {}) as Prisma.InputJsonValue })),
  };
}
```

- [ ] **Step 3: Service + controller**

`apps/api/src/rd/rd-sync.service.ts`:
```ts
import { Injectable, Logger } from '@nestjs/common';
import type { SyncRunView } from '@rd/shared';
import { BusinessError } from '../common/errors';
import { PrismaService } from '../prisma/prisma.service';
import { RdConnectionService } from './rd-connection.service';
import type { RdClient } from './rd-client';
import { mapContact, type RdContact, type RdEvent, type RdFunnel } from './rd-mapper';

const PAGE_SIZE = 125;
const CONCORRENCIA = 4;
interface Stats { lidos: number; criados: number; atualizados: number; erros: number }

/**
 * Carga inicial: pagina a segmentação "todos", enriquece cada contato (detalhe +
 * funil + eventos) e faz upsert. `SyncRun.cursor` = última página concluída →
 * retomável. ponytail: roda em processo, uma execução por conta (Map de locks);
 * BullMQ entra no Plano 2 junto com webhooks/cron.
 */
@Injectable()
export class RdSyncService {
  private readonly log = new Logger(RdSyncService.name);
  private readonly emAndamento = new Set<string>();

  constructor(private readonly prisma: PrismaService, private readonly conn: RdConnectionService) {}

  /** Dispara em background e devolve o id do run. */
  async start(accountId: string): Promise<{ runId: string }> {
    if (this.emAndamento.has(accountId)) throw new BusinessError('Já existe uma sincronização em andamento');
    const ultimo = await this.prisma.syncRun.findFirst({ where: { accountId, kind: 'full', finishedAt: null }, orderBy: { startedAt: 'desc' } });
    const fromCursor = ultimo?.cursor ?? 0;
    const run = ultimo ?? (await this.prisma.syncRun.create({ data: { accountId, kind: 'full' } }));
    void this.runFull(accountId, { fromCursor, runId: run.id }).catch((e) => this.log.error(`sync ${accountId}: ${e}`));
    return { runId: run.id };
  }

  async runFull(accountId: string, o: { fromCursor: number; runId?: string }): Promise<void> {
    this.emAndamento.add(accountId);
    const runId = o.runId ?? (await this.prisma.syncRun.create({ data: { accountId, kind: 'full', cursor: o.fromCursor } })).id;
    const stats: Stats = { lidos: 0, criados: 0, atualizados: 0, erros: 0 };
    try {
      const c = await this.prisma.rdConnection.findUnique({ where: { accountId } });
      if (!c?.segmentationId) throw new BusinessError('Escolha a segmentação antes de sincronizar');
      const client = await this.conn.client(accountId);
      for (let page = o.fromCursor + 1; ; page++) {
        const r = await client.get<{ contacts: RdContact[] }>(`/platform/segmentations/${c.segmentationId}/contacts`, { page, page_size: PAGE_SIZE });
        if (r.contacts.length === 0) break;
        await this.emLotes(r.contacts, CONCORRENCIA, async (contato) => {
          try { await this.upsertContato(accountId, client, contato.uuid, stats); }
          catch (e) { stats.erros++; this.log.warn(`lead ${contato.uuid}: ${e instanceof Error ? e.message : e}`); }
        });
        await this.prisma.syncRun.update({ where: { id: runId }, data: { cursor: page, stats } });
        if (r.contacts.length < PAGE_SIZE) break;
      }
      await this.prisma.syncRun.update({ where: { id: runId }, data: { finishedAt: new Date(), stats } });
      await this.prisma.rdConnection.update({ where: { accountId }, data: { lastFullSyncAt: new Date(), status: 'active', lastError: null } });
    } catch (e) {
      await this.prisma.syncRun.update({ where: { id: runId }, data: { finishedAt: new Date(), stats, error: (e instanceof Error ? e.message : String(e)).slice(0, 500) } });
      await this.conn.marcarErro(accountId, e);
      throw e;
    } finally { this.emAndamento.delete(accountId); }
  }

  /** Enriquece um contato e grava. Reusado pelo webhook/delta no Plano 2. */
  async upsertContato(accountId: string, client: RdClient, uuid: string, stats?: Stats): Promise<void> {
    const [contato, funil, eventos] = await Promise.all([
      client.get<RdContact>(`/platform/contacts/uuid:${uuid}`),
      client.get<RdFunnel>(`/platform/contacts/uuid:${uuid}/funnels/default`).catch(() => null),
      this.todosEventos(client, uuid),
    ]);
    const m = mapContact(contato, funil, eventos);
    const antes = await this.prisma.lead.findUnique({ where: { accountId_rdUuid: { accountId, rdUuid: uuid } }, select: { id: true } }).catch(() => null);
    const lead = await this.prisma.lead.upsert({ where: { accountId_rdUuid: { accountId, rdUuid: uuid } }, create: { accountId, ...m.lead }, update: m.lead });
    if (m.events.length) await this.prisma.leadEvent.createMany({ data: m.events.map((e) => ({ ...e, accountId, leadId: lead.id })), skipDuplicates: true });
    if (stats) { stats.lidos++; if (antes) stats.atualizados++; else stats.criados++; }
  }

  private async todosEventos(client: RdClient, uuid: string): Promise<RdEvent[]> {
    const out: RdEvent[] = [];
    for (let page = 1; page <= 50; page++) {
      const r = await client.get<{ events?: RdEvent[] } | RdEvent[]>(`/platform/contacts/${uuid}/events`, { event_type: 'CONVERSION', page });
      const lista = Array.isArray(r) ? r : (r.events ?? []);
      out.push(...lista);
      if (lista.length < 10) break;
    }
    return out;
  }

  private async emLotes<T>(itens: T[], n: number, fn: (i: T) => Promise<void>): Promise<void> {
    for (let i = 0; i < itens.length; i += n) await Promise.all(itens.slice(i, i + n).map(fn));
  }

  async status(accountId: string): Promise<SyncRunView | null> {
    const r = await this.prisma.syncRun.findFirst({ where: { accountId }, orderBy: { startedAt: 'desc' } });
    return r ? { id: r.id, kind: r.kind, startedAt: r.startedAt.toISOString(), finishedAt: r.finishedAt?.toISOString() ?? null, cursor: r.cursor, stats: r.stats as SyncRunView['stats'], error: r.error } : null;
  }
}
```

`apps/api/src/rd/rd-sync.controller.ts`:
```ts
import { Controller, Get, Post } from '@nestjs/common';
import type { SyncRunView } from '@rd/shared';
import { CurrentUser, RequireAdmin } from '../auth/auth.decorators';
import type { AuthUser } from '../auth/auth.types';
import { RdSyncService } from './rd-sync.service';

@Controller('rd/sync')
export class RdSyncController {
  constructor(private readonly svc: RdSyncService) {}
  @RequireAdmin() @Post() start(@CurrentUser() u: AuthUser): Promise<{ runId: string }> { return this.svc.start(u.accountId); }
  @Get('status') status(@CurrentUser() u: AuthUser): Promise<SyncRunView | null> { return this.svc.status(u.accountId); }
}
```

- [ ] **Step 4: Rodar tudo**

```bash
corepack pnpm --filter @rd/api test
corepack pnpm --filter @rd/api typecheck
corepack pnpm --filter @rd/api test:boot
```
Expected: PASS em tudo (o spec do sync: 2 testes). Se o `findFirst` do run aberto fizer o teste retomar do cursor errado, conferir que o mock devolve `null` (é o que está acima).

- [ ] **Step 5: Commit**

```bash
```

---

### Task 9: API — listagem e ficha de leads

**Files:**
- Create: `apps/api/src/leads/leads.service.ts`, `leads.service.spec.ts`, `leads.controller.ts`
- Modify: `apps/api/src/leads/leads.module.ts`

- [ ] **Step 1: Teste do `where` (falha primeiro)**

`apps/api/src/leads/leads.service.spec.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { leadsQuerySchema } from '@rd/shared';
import { buildWhere } from './leads.service';

describe('buildWhere', () => {
  it('sempre corta por accountId e combina filtros', () => {
    const w = buildWhere('acc', leadsQuerySchema.parse({ q: 'ana', tags: 'vip,quente', lifecycleStage: 'Lead', oportunidade: 'true', uf: 'PR', de: '2026-09-01', conversao: 'forms' }));
    expect(w.accountId).toBe('acc');
    expect(w.tags).toEqual({ hasEvery: ['vip', 'quente'] });
    expect(w.lifecycleStage).toEqual({ in: ['Lead'] });
    expect(w.opportunity).toBe(true);
    expect(w.state).toBe('PR');
    expect(w.lastConversionAt).toEqual({ gte: new Date('2026-09-01') });
    expect(w.events).toEqual({ some: { identifier: { contains: 'forms', mode: 'insensitive' } } });
    expect(w.OR).toHaveLength(4);
  });
  it('sem filtros → só accountId', () => {
    expect(buildWhere('acc', leadsQuerySchema.parse({}))).toEqual({ accountId: 'acc' });
  });
});
```

Run: `corepack pnpm --filter @rd/api test -- leads`
Expected: FAIL.

- [ ] **Step 2: Service**

`apps/api/src/leads/leads.service.ts`:
```ts
import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { LeadDetail, LeadFacets, LeadRow, LeadsQuery, Page } from '@rd/shared';
import { NotFoundError } from '../common/errors';
import { PrismaService } from '../prisma/prisma.service';

export function buildWhere(accountId: string, q: LeadsQuery): Prisma.LeadWhereInput {
  const w: Prisma.LeadWhereInput = { accountId };
  if (q.q) w.OR = ['name', 'email', 'phone', 'company'].map((f) => ({ [f]: { contains: q.q, mode: 'insensitive' } }));
  if (q.tags?.length) w.tags = { hasEvery: q.tags };
  if (q.lifecycleStage?.length) w.lifecycleStage = { in: q.lifecycleStage };
  if (q.oportunidade !== undefined) w.opportunity = q.oportunidade;
  if (q.cidade) w.city = { contains: q.cidade, mode: 'insensitive' };
  if (q.uf) w.state = q.uf;
  if (q.de || q.ate) w.lastConversionAt = { ...(q.de ? { gte: q.de } : {}), ...(q.ate ? { lte: q.ate } : {}) };
  if (q.conversao) w.events = { some: { identifier: { contains: q.conversao, mode: 'insensitive' } } };
  return w;
}

const ROW_SELECT = { id: true, rdUuid: true, name: true, email: true, phone: true, city: true, state: true, company: true, jobTitle: true, tags: true, lifecycleStage: true, opportunity: true, fit: true, interest: true, conversionsCount: true, firstConversionAt: true, lastConversionAt: true, rdCreatedAt: true } as const;
type Row = Prisma.LeadGetPayload<{ select: typeof ROW_SELECT }>;
const iso = (d: Date | null): string | null => d?.toISOString() ?? null;
const toRow = (l: Row): LeadRow => ({ ...l, firstConversionAt: iso(l.firstConversionAt), lastConversionAt: iso(l.lastConversionAt), rdCreatedAt: iso(l.rdCreatedAt) });

@Injectable()
export class LeadsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(accountId: string, q: LeadsQuery): Promise<Page<LeadRow>> {
    const where = buildWhere(accountId, q);
    const [items, total] = await Promise.all([
      this.prisma.lead.findMany({ where, select: ROW_SELECT, orderBy: { [q.sort]: q.dir }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
      this.prisma.lead.count({ where }),
    ]);
    return { items: items.map(toRow), total, page: q.page, pageSize: q.pageSize };
  }

  async facets(accountId: string): Promise<LeadFacets> {
    // account-raw: agregação de tags (array) não existe no Prisma; accountId parametrizado.
    const tags = await this.prisma.$queryRaw<Array<{ value: string; count: bigint }>>`SELECT t AS value, COUNT(*) AS count FROM "Lead", unnest(tags) AS t WHERE "accountId" = ${accountId} GROUP BY t ORDER BY count DESC LIMIT 100`;
    const stages = await this.prisma.lead.groupBy({ by: ['lifecycleStage'], where: { accountId, lifecycleStage: { not: null } }, _count: { _all: true } });
    const conv = await this.prisma.leadEvent.groupBy({ by: ['identifier'], where: { accountId, type: 'CONVERSION' }, _count: { _all: true }, orderBy: { _count: { identifier: 'desc' } }, take: 50 });
    return {
      tags: tags.map((t) => ({ value: t.value, count: Number(t.count) })),
      lifecycleStages: stages.map((s) => ({ value: s.lifecycleStage!, count: s._count._all })),
      conversoes: conv.map((c) => ({ value: c.identifier, count: c._count._all })),
    };
  }

  async detail(accountId: string, id: string): Promise<LeadDetail> {
    // Corte por conta no próprio where: lead de outra conta → 404, nunca 403.
    const l = await this.prisma.lead.findFirst({ where: { id, accountId }, select: { ...ROW_SELECT, customFields: true, events: { orderBy: { occurredAt: 'desc' }, select: { id: true, type: true, identifier: true, occurredAt: true, payload: true } } } });
    if (!l) throw new NotFoundError('Lead não encontrado');
    return { ...toRow(l), customFields: (l.customFields ?? {}) as Record<string, unknown>, events: l.events.map((e) => ({ id: e.id, type: e.type, identifier: e.identifier, occurredAt: e.occurredAt.toISOString(), payload: (e.payload ?? {}) as Record<string, unknown> })) };
  }
}
```

- [ ] **Step 3: Controller + módulo**

`apps/api/src/leads/leads.controller.ts`:
```ts
import { Controller, Get, Param, Query } from '@nestjs/common';
import { leadsQuerySchema, type LeadDetail, type LeadFacets, type LeadRow, type LeadsQuery, type Page } from '@rd/shared';
import { CurrentUser } from '../auth/auth.decorators';
import type { AuthUser } from '../auth/auth.types';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { LeadsService } from './leads.service';

@Controller('leads')
export class LeadsController {
  constructor(private readonly svc: LeadsService) {}
  @Get() list(@CurrentUser() u: AuthUser, @Query(new ZodValidationPipe(leadsQuerySchema)) q: LeadsQuery): Promise<Page<LeadRow>> { return this.svc.list(u.accountId, q); }
  @Get('facets') facets(@CurrentUser() u: AuthUser): Promise<LeadFacets> { return this.svc.facets(u.accountId); }
  @Get(':id') detail(@CurrentUser() u: AuthUser, @Param('id') id: string): Promise<LeadDetail> { return this.svc.detail(u.accountId, id); }
}
```

`apps/api/src/leads/leads.module.ts`:
```ts
import { Module } from '@nestjs/common';
import { LeadsController } from './leads.controller';
import { LeadsService } from './leads.service';
@Module({ controllers: [LeadsController], providers: [LeadsService] })
export class LeadsModule {}
```

- [ ] **Step 4: Rodar + commit**

```bash
corepack pnpm --filter @rd/api test && corepack pnpm --filter @rd/api typecheck && corepack pnpm --filter @rd/api test:boot
```

---

### Task 10: Web — esqueleto, client HTTP, sessão e rotas

**Files:**
- Create: `apps/web/package.json`, `vite.config.ts`, `tsconfig.json`, `index.html`, `src/main.tsx`, `src/App.tsx`, `src/styles.css`, `src/lib/apiClient.ts`, `src/lib/authStore.ts`, `src/lib/queryClient.ts`, `src/auth/AuthContext.tsx`, `src/auth/ProtectedRoute.tsx`, `src/app/AppLayout.tsx`, `src/features/auth/LoginPage.tsx`, `src/features/auth/RegisterPage.tsx`

- [ ] **Step 1: Manifesto e configs**

`apps/web/package.json`:
```json
{
  "name": "@rd/web",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": { "dev": "vite", "build": "tsc -p tsconfig.json --noEmit && vite build", "typecheck": "tsc -p tsconfig.json --noEmit", "test": "vitest run" },
  "dependencies": {
    "@rd/shared": "workspace:*",
    "@tanstack/react-query": "^5.62.11",
    "lucide-react": "^1.17.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "react-router-dom": "^7.1.1",
    "zod": "^3.24.1"
  },
  "devDependencies": {
    "@testing-library/react": "^16.1.0",
    "@types/react": "^19.0.2",
    "@types/react-dom": "^19.0.2",
    "@vitejs/plugin-react": "^4.3.4",
    "jsdom": "^25.0.1",
    "typescript": "^5.7.2",
    "vite": "^6.0.7",
    "vitest": "^2.1.8"
  }
}
```

`apps/web/vite.config.ts`:
```ts
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
export default defineConfig({
  plugins: [react()],
  server: { host: true, port: 22500, strictPort: true, proxy: { '/api': { target: 'http://127.0.0.1:22501', changeOrigin: true } } },
  test: { environment: 'jsdom', globals: true, include: ['src/**/*.test.{ts,tsx}'] },
});
```

`apps/web/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "lib": ["ES2022", "DOM", "DOM.Iterable"], "jsx": "react-jsx", "module": "ESNext", "moduleResolution": "Bundler", "types": ["vite/client", "vitest/globals"], "noEmit": true, "allowImportingTsExtensions": true },
  "include": ["src", "vite.config.ts"]
}
```

`apps/web/index.html`:
```html
<!doctype html>
<html lang="pt-BR">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>RD Insights</title>
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet" />
  </head>
  <body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body>
</html>
```

- [ ] **Step 2: Estilos base (CSS puro, tokens)**

`apps/web/src/styles.css`:
```css
:root {
  --bg: #0f1115; --panel: #171a21; --panel-2: #1e222b; --border: #2a2f3a; --text: #e6e8ee; --muted: #8b92a5;
  --primary: #4f8cff; --primary-strong: #2f6fe0; --ok: #2ecc71; --warn: #f5a623; --bad: #ff5c5c; --radius: 10px;
  --font: 'Inter', system-ui, sans-serif; --mono: 'JetBrains Mono', ui-monospace, monospace;
}
* { box-sizing: border-box; }
html, body, #root { height: 100%; margin: 0; }
body { background: var(--bg); color: var(--text); font: 14px/1.45 var(--font); }
a { color: var(--primary); text-decoration: none; }
button, input, select { font: inherit; }
.btn { background: var(--primary); color: #fff; border: 0; border-radius: 8px; padding: 9px 14px; font-weight: 600; cursor: pointer; }
.btn:hover { background: var(--primary-strong); } .btn:disabled { opacity: .5; cursor: default; }
.btn.ghost { background: transparent; border: 1px solid var(--border); color: var(--text); }
.input { width: 100%; background: var(--panel-2); color: var(--text); border: 1px solid var(--border); border-radius: 8px; padding: 9px 11px; }
.input:focus { outline: none; border-color: var(--primary); box-shadow: 0 0 0 3px rgba(79,140,255,.25); }
.card { background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius); padding: 20px; }
.muted { color: var(--muted); } .mono { font-family: var(--mono); }
.alert { background: rgba(255,92,92,.12); border: 1px solid rgba(255,92,92,.4); color: #ffb3b3; border-radius: 8px; padding: 10px 12px; margin-bottom: 12px; }
.auth-wrap { min-height: 100%; display: grid; place-items: center; padding: 24px; }
.auth-card { width: 100%; max-width: 400px; }
.field { display: grid; gap: 6px; margin-bottom: 14px; } .field label { font-size: 12px; color: var(--muted); font-weight: 600; text-transform: uppercase; letter-spacing: .04em; }
.layout { display: grid; grid-template-columns: 220px 1fr; min-height: 100%; }
.sidebar { background: var(--panel); border-right: 1px solid var(--border); padding: 18px 12px; display: flex; flex-direction: column; gap: 4px; }
.sidebar .brand { font-weight: 700; padding: 6px 10px 16px; font-size: 16px; }
.sidebar a { color: var(--text); padding: 8px 10px; border-radius: 8px; display: flex; gap: 8px; align-items: center; }
.sidebar a.active, .sidebar a:hover { background: var(--panel-2); }
.sidebar .spacer { flex: 1; }
.main { padding: 24px 28px; min-width: 0; }
.page-title { margin: 0 0 16px; font-size: 20px; }
.toolbar { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-bottom: 12px; }
.toolbar .input { width: auto; min-width: 220px; }
table.grid { width: 100%; border-collapse: collapse; background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; }
.grid th, .grid td { padding: 9px 10px; border-bottom: 1px solid var(--border); text-align: left; white-space: nowrap; }
.grid th { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .04em; cursor: pointer; user-select: none; }
.grid tr:hover td { background: var(--panel-2); }
.grid td.ellipsis { max-width: 260px; overflow: hidden; text-overflow: ellipsis; }
.chip { display: inline-block; background: var(--panel-2); border: 1px solid var(--border); border-radius: 999px; padding: 1px 8px; font-size: 12px; margin-right: 4px; }
.chip.stage { border-color: rgba(79,140,255,.5); color: #b9d0ff; }
.pager { display: flex; gap: 8px; align-items: center; justify-content: flex-end; margin-top: 12px; }
.kv { display: grid; grid-template-columns: 160px 1fr; gap: 6px 12px; } .kv dt { color: var(--muted); } .kv dd { margin: 0; }
.timeline li { padding: 8px 0; border-bottom: 1px solid var(--border); display: flex; gap: 12px; }
.steps { display: grid; gap: 14px; max-width: 560px; }
.step { display: flex; gap: 12px; align-items: flex-start; } .step .n { width: 26px; height: 26px; border-radius: 50%; display: grid; place-items: center; background: var(--panel-2); font-weight: 700; flex: none; }
.step.done .n { background: var(--ok); color: #062; }
.progress { height: 8px; background: var(--panel-2); border-radius: 999px; overflow: hidden; } .progress > div { height: 100%; background: var(--primary); transition: width .3s; }
@media (max-width: 800px) { .layout { grid-template-columns: 1fr; } .sidebar { flex-direction: row; overflow-x: auto; } .sidebar .spacer, .sidebar .brand { display: none; } .main { padding: 16px; } }
```

- [ ] **Step 3: Client HTTP + sessão**

`apps/web/src/lib/authStore.ts`:
```ts
let accessToken: string | null = null;
let onUnauthorized: (() => void) | null = null;
export const authStore = {
  get: (): string | null => accessToken,
  set: (t: string | null): void => { accessToken = t; },
  setOnUnauthorized: (fn: (() => void) | null): void => { onUnauthorized = fn; },
  notifyUnauthorized: (): void => { onUnauthorized?.(); },
};
```

`apps/web/src/lib/apiClient.ts`:
```ts
import { authStore } from './authStore';

export class ApiError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string, public readonly errors?: Array<{ path: string; message: string }>) { super(message); this.name = 'ApiError'; }
}
const BASE = '/api';
let refreshing: Promise<string | null> | null = null;

async function doRefresh(): Promise<string | null> {
  try {
    const r = await fetch(`${BASE}/auth/refresh`, { method: 'POST', credentials: 'include' });
    if (!r.ok) return null;
    const b = (await r.json()) as { accessToken: string };
    authStore.set(b.accessToken);
    return b.accessToken;
  } catch { return null; }
}
export function refreshOnce(): Promise<string | null> { refreshing ??= doRefresh().finally(() => { refreshing = null; }); return refreshing; }

function raw(path: string, init: RequestInit, token: string | null): Promise<Response> {
  return fetch(`${BASE}${path}`, { ...init, credentials: 'include', headers: { ...(init.body != null ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...init.headers } });
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res = await raw(path, init, authStore.get());
  if (res.status === 401 && !path.startsWith('/auth/')) {
    const t = await refreshOnce();
    if (!t) { authStore.notifyUnauthorized(); throw new ApiError(401, 'UNAUTHORIZED', 'Sessão expirada'); }
    res = await raw(path, init, t);
  }
  const body = res.headers.get('content-type')?.includes('application/json') ? await res.json() : null;
  if (!res.ok) throw new ApiError(res.status, body?.code ?? 'ERROR', body?.message ?? `Erro ${res.status}`, body?.errors);
  return body as T;
}

export const api = {
  get: <T>(p: string) => request<T>(p),
  post: <T>(p: string, data?: unknown) => request<T>(p, { method: 'POST', body: data === undefined ? undefined : JSON.stringify(data) }),
};
export const qs = (o: Record<string, unknown>): string => { const u = new URLSearchParams(); for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== '' && v !== null) u.set(k, Array.isArray(v) ? v.join(',') : String(v)); const s = u.toString(); return s ? `?${s}` : ''; };
```

`apps/web/src/lib/queryClient.ts`:
```ts
import { QueryClient } from '@tanstack/react-query';
export const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 30_000, retry: 1, refetchOnWindowFocus: false } } });
```

`apps/web/src/auth/AuthContext.tsx`:
```tsx
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { AuthResponse, LoginDto, RegisterDto, SessionUser } from '@rd/shared';
import { api, refreshOnce } from '../lib/apiClient';
import { authStore } from '../lib/authStore';

type Status = 'loading' | 'authenticated' | 'anonymous';
interface Ctx { status: Status; user: SessionUser | null; login: (d: LoginDto) => Promise<void>; register: (d: RegisterDto) => Promise<void>; logout: () => Promise<void> }
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
    login: async (d) => apply(await api.post<AuthResponse>('/auth/login', d)),
    register: async (d) => apply(await api.post<AuthResponse>('/auth/register', d)),
    logout: async () => { try { await api.post('/auth/logout'); } finally { clear(); } },
  }), [status, user, apply, clear]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
export function useAuth(): Ctx { const c = useContext(AuthContext); if (!c) throw new Error('useAuth fora do AuthProvider'); return c; }
```

`apps/web/src/auth/ProtectedRoute.tsx`:
```tsx
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from './AuthContext';
export function ProtectedRoute(): React.ReactElement {
  const { status } = useAuth();
  const loc = useLocation();
  if (status === 'loading') return <div className="auth-wrap muted">Carregando…</div>;
  if (status === 'anonymous') return <Navigate to="/login" replace state={{ from: loc.pathname }} />;
  return <Outlet />;
}
```

- [ ] **Step 4: Layout, páginas de auth, App**

`apps/web/src/app/AppLayout.tsx`:
```tsx
import { LogOut, Plug, Users } from 'lucide-react';
import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
export function AppLayout(): React.ReactElement {
  const { user, logout } = useAuth();
  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand">RD Insights</div>
        <NavLink to="/leads"><Users size={16} /> Leads</NavLink>
        <NavLink to="/conectar"><Plug size={16} /> Conexão RD</NavLink>
        <div className="spacer" />
        <div className="muted" style={{ padding: '6px 10px', fontSize: 12 }}>{user?.accountName}<br />{user?.email}</div>
        <a href="#" onClick={(e) => { e.preventDefault(); void logout(); }}><LogOut size={16} /> Sair</a>
      </aside>
      <main className="main"><Outlet /></main>
    </div>
  );
}
```

`apps/web/src/features/auth/LoginPage.tsx`:
```tsx
import { useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { ApiError } from '../../lib/apiClient';

export function LoginPage(): React.ReactElement {
  const { login, status } = useAuth();
  const navigate = useNavigate();
  const loc = useLocation();
  const [email, setEmail] = useState(''); const [password, setPassword] = useState('');
  const [erro, setErro] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  if (status === 'authenticated') return <Navigate to="/" replace />;
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setErro(null); setBusy(true);
    try { await login({ email, password }); navigate((loc.state as { from?: string } | null)?.from ?? '/', { replace: true }); }
    catch (err) { setErro(err instanceof ApiError ? err.message : 'Não foi possível entrar'); }
    finally { setBusy(false); }
  };
  return (
    <div className="auth-wrap"><form className="card auth-card" onSubmit={submit}>
      <h1 style={{ marginTop: 0 }}>Entrar</h1>
      {erro && <div className="alert">{erro}</div>}
      <div className="field"><label htmlFor="email">E-mail</label><input id="email" className="input" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required /></div>
      <div className="field"><label htmlFor="password">Senha</label><input id="password" className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></div>
      <button className="btn" type="submit" disabled={busy} style={{ width: '100%' }}>{busy ? 'Entrando…' : 'Entrar'}</button>
      <p className="muted" style={{ marginBottom: 0 }}>Sem conta? <Link to="/registrar">Criar conta</Link></p>
    </form></div>
  );
}
```

`apps/web/src/features/auth/RegisterPage.tsx`:
```tsx
import { useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { ApiError } from '../../lib/apiClient';

export function RegisterPage(): React.ReactElement {
  const { register, status } = useAuth();
  const navigate = useNavigate();
  const [f, setF] = useState({ accountName: '', name: '', email: '', password: '' });
  const [erro, setErro] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  if (status === 'authenticated') return <Navigate to="/" replace />;
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setErro(null); setBusy(true);
    try { await register(f); navigate('/conectar', { replace: true }); }
    catch (err) { setErro(err instanceof ApiError ? (err.errors?.map((x) => `${x.path}: ${x.message}`).join('; ') || err.message) : 'Não foi possível criar a conta'); }
    finally { setBusy(false); }
  };
  return (
    <div className="auth-wrap"><form className="card auth-card" onSubmit={submit}>
      <h1 style={{ marginTop: 0 }}>Criar conta</h1>
      {erro && <div className="alert">{erro}</div>}
      <div className="field"><label htmlFor="accountName">Nome da empresa / conta</label><input id="accountName" className="input" value={f.accountName} onChange={set('accountName')} required /></div>
      <div className="field"><label htmlFor="name">Seu nome</label><input id="name" className="input" value={f.name} onChange={set('name')} required /></div>
      <div className="field"><label htmlFor="email">E-mail</label><input id="email" className="input" type="email" value={f.email} onChange={set('email')} required /></div>
      <div className="field"><label htmlFor="password">Senha (mín. 10)</label><input id="password" className="input" type="password" minLength={10} value={f.password} onChange={set('password')} required /></div>
      <button className="btn" type="submit" disabled={busy} style={{ width: '100%' }}>{busy ? 'Criando…' : 'Criar conta'}</button>
      <p className="muted" style={{ marginBottom: 0 }}>Já tem conta? <Link to="/login">Entrar</Link></p>
    </form></div>
  );
}
```

`apps/web/src/App.tsx`:
```tsx
import { QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AppLayout } from './app/AppLayout';
import { AuthProvider } from './auth/AuthContext';
import { ProtectedRoute } from './auth/ProtectedRoute';
import { LoginPage } from './features/auth/LoginPage';
import { RegisterPage } from './features/auth/RegisterPage';
import { ConectarRdPage } from './features/onboarding/ConectarRdPage';
import { LeadDetalhePage } from './features/leads/LeadDetalhePage';
import { LeadsPage } from './features/leads/LeadsPage';
import { queryClient } from './lib/queryClient';

export function App(): React.ReactElement {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/registrar" element={<RegisterPage />} />
            <Route element={<ProtectedRoute />}>
              <Route element={<AppLayout />}>
                <Route index element={<Navigate to="/leads" replace />} />
                <Route path="/leads" element={<LeadsPage />} />
                <Route path="/leads/:id" element={<LeadDetalhePage />} />
                <Route path="/conectar" element={<ConectarRdPage />} />
              </Route>
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
```

`apps/web/src/main.tsx`:
```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';
createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
```

- [ ] **Step 5: Stubs das páginas** (preenchidas nas Tasks 11 e 12) — criar `src/features/onboarding/ConectarRdPage.tsx`, `src/features/leads/LeadsPage.tsx`, `src/features/leads/LeadDetalhePage.tsx` com:
```tsx
export function ConectarRdPage(): React.ReactElement { return <h1 className="page-title">Conexão RD</h1>; }
```
(idem `LeadsPage`, `LeadDetalhePage` com seus nomes.)

- [ ] **Step 6: Instalar, typecheck, smoke visual**

```bash
corepack pnpm install
corepack pnpm --filter @rd/web typecheck
corepack pnpm dev
```
Abrir `http://localhost:22500/registrar` → criar conta → cai em `/conectar` com o layout. Recarregar mantém a sessão (refresh via cookie). Sair volta ao login.

- [ ] **Step 7: Commit**

```bash
```

---

### Task 11: Web — onboarding "Conectar RD" (credenciais → autorizar → segmentação → carga)

**Files:**
- Create: `apps/web/src/features/onboarding/rdApi.ts`
- Modify: `apps/web/src/features/onboarding/ConectarRdPage.tsx`

- [ ] **Step 1: API hooks**

`apps/web/src/features/onboarding/rdApi.ts`:
```ts
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { RdConnectionView, RdCredentialsDto, RdSegmentation, RdSegmentationDto, SyncRunView } from '@rd/shared';
import { api } from '../../lib/apiClient';

export const useRdConnection = () => useQuery({ queryKey: ['rd', 'connection'], queryFn: () => api.get<RdConnectionView>('/rd/connection') });
export const useSegmentations = (enabled: boolean) => useQuery({ queryKey: ['rd', 'segmentations'], queryFn: () => api.get<RdSegmentation[]>('/rd/segmentations'), enabled, retry: 0 });
export const useSyncStatus = (ativo: boolean) => useQuery({ queryKey: ['rd', 'sync'], queryFn: () => api.get<SyncRunView | null>('/rd/sync/status'), refetchInterval: (q) => (ativo && !q.state.data?.finishedAt ? 2000 : false) });
export function useRdMutations() {
  const qc = useQueryClient();
  const inv = () => qc.invalidateQueries({ queryKey: ['rd'] });
  return {
    credentials: useMutation({ mutationFn: (d: RdCredentialsDto) => api.post<RdConnectionView>('/rd/credentials', d), onSuccess: inv }),
    authorize: useMutation({ mutationFn: () => api.get<{ url: string }>('/rd/authorize-url'), onSuccess: ({ url }) => { window.location.href = url; } }),
    segmentation: useMutation({ mutationFn: (d: RdSegmentationDto) => api.post<RdConnectionView>('/rd/segmentation', d), onSuccess: inv }),
    sync: useMutation({ mutationFn: () => api.post<{ runId: string }>('/rd/sync'), onSuccess: inv }),
  };
}
```

- [ ] **Step 2: Página**

`apps/web/src/features/onboarding/ConectarRdPage.tsx`:
```tsx
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError } from '../../lib/apiClient';
import { useRdConnection, useRdMutations, useSegmentations, useSyncStatus } from './rdApi';

const msg = (e: unknown): string => (e instanceof ApiError ? e.message : 'Falhou');

export function ConectarRdPage(): React.ReactElement {
  const { data: c, isLoading } = useRdConnection();
  const m = useRdMutations();
  const [clientId, setClientId] = useState(''); const [clientSecret, setClientSecret] = useState('');
  const autorizado = c?.status === 'authorized' || c?.status === 'active';
  const { data: segs, error: segErro } = useSegmentations(autorizado && !c?.segmentationId);
  const { data: run } = useSyncStatus(c?.status === 'active');
  if (isLoading || !c) return <p className="muted">Carregando…</p>;

  const pct = run?.stats?.totalPaginas ? Math.min(100, Math.round((run.cursor / run.stats.totalPaginas) * 100)) : null;
  const callback = `${window.location.origin}/api/rd/callback`;

  return (
    <>
      <h1 className="page-title">Conexão com o RD Station Marketing</h1>
      {c.lastError && <div className="alert">Último erro: {c.lastError}</div>}
      {c.status === 'reauth_required' && <div className="alert">O RD revogou o acesso. Autorize de novo no passo 2.</div>}
      <div className="steps">
        <div className={`step ${c.hasClientSecret ? 'done' : ''}`}><div className="n">1</div><div className="card" style={{ flex: 1 }}>
          <strong>Credenciais do app</strong>
          <p className="muted">Crie um app em <a href="https://appstore.rdstation.com" target="_blank" rel="noreferrer">appstore.rdstation.com</a> com URL de callback <code className="mono">{callback}</code> e cole aqui.</p>
          <div className="field"><label>client_id</label><input className="input" value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder={c.clientId ?? ''} /></div>
          <div className="field"><label>client_secret {c.hasClientSecret && <span className="muted">(já salvo — preencha só para trocar)</span>}</label><input className="input" type="password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} /></div>
          <button className="btn" disabled={!clientId || !clientSecret || m.credentials.isPending} onClick={() => m.credentials.mutate({ clientId, clientSecret }, { onSuccess: () => setClientSecret('') })}>Salvar</button>
          {m.credentials.error && <div className="alert" style={{ marginTop: 10 }}>{msg(m.credentials.error)}</div>}
        </div></div>

        <div className={`step ${autorizado ? 'done' : ''}`}><div className="n">2</div><div className="card" style={{ flex: 1 }}>
          <strong>Autorizar no RD</strong>
          <p className="muted">Abre a tela do RD; entre com um usuário que tenha acesso ao RD Marketing da conta.</p>
          <button className="btn" disabled={!c.hasClientSecret || m.authorize.isPending} onClick={() => m.authorize.mutate()}>{autorizado ? 'Autorizar de novo' : 'Autorizar'}</button>
        </div></div>

        <div className={`step ${c.segmentationId ? 'done' : ''}`}><div className="n">3</div><div className="card" style={{ flex: 1 }}>
          <strong>Segmentação "todos os leads"</strong>
          {c.segmentationId ? <p>Usando <b>{c.segmentationName}</b>.</p> : autorizado ? (
            segErro ? <div className="alert">{msg(segErro)}</div> : !segs ? <p className="muted">Carregando segmentações…</p> : (
              <select className="input" defaultValue="" onChange={(e) => { const s = segs.find((x) => x.id === e.target.value); if (s) m.segmentation.mutate({ segmentationId: s.id, segmentationName: s.name }); }}>
                <option value="" disabled>Escolha a segmentação que contém todos os leads</option>
                {segs.map((s) => <option key={s.id} value={s.id}>{s.name}{s.standard ? ' (padrão)' : ''}</option>)}
              </select>
            )
          ) : <p className="muted">Autorize primeiro.</p>}
        </div></div>

        <div className={`step ${c.lastFullSyncAt ? 'done' : ''}`}><div className="n">4</div><div className="card" style={{ flex: 1 }}>
          <strong>Carga inicial</strong>
          {run && !run.finishedAt ? (<>
            <p>Sincronizando… página {run.cursor} · {run.stats.lidos ?? 0} leads lidos, {run.stats.erros ?? 0} erros</p>
            <div className="progress"><div style={{ width: `${pct ?? 50}%` }} /></div>
          </>) : (<>
            {run?.finishedAt && <p className="muted">Última: {new Date(run.finishedAt).toLocaleString('pt-BR')} · {run.stats.lidos ?? 0} lidos, {run.stats.criados ?? 0} novos, {run.stats.atualizados ?? 0} atualizados{run.error ? ` · erro: ${run.error}` : ''}</p>}
            <button className="btn" disabled={c.status !== 'active' || m.sync.isPending} onClick={() => m.sync.mutate()}>{c.lastFullSyncAt ? 'Sincronizar de novo' : 'Iniciar carga'}</button>
            {m.sync.error && <div className="alert" style={{ marginTop: 10 }}>{msg(m.sync.error)}</div>}
            {c.lastFullSyncAt && <p style={{ marginBottom: 0 }}><Link to="/leads">Ver leads →</Link></p>}
          </>)}
        </div></div>
      </div>
    </>
  );
}
```

- [ ] **Step 3: Typecheck + fluxo real**

`corepack pnpm --filter @rd/web typecheck` → sem erros. Com o `.env` apontando `APP_URL=http://localhost:22500` e o app do RD com callback `http://localhost:22500/api/rd/callback`: preencher credenciais → Autorizar → volta em `/conectar` com passo 2 verde → escolher segmentação → Iniciar carga → barra avança → `/leads` lista.

Se o RD não aceitar `http://localhost` como callback, usar um túnel (`cloudflared tunnel --url http://localhost:22500`) e colocar a URL do túnel em `APP_URL` e no app do RD.

- [ ] **Step 4: Commit**

```bash
```

---

### Task 12: Web — lista de leads (busca, filtros, ordenação, paginação) e ficha

**Files:**
- Create: `apps/web/src/features/leads/leadsApi.ts`, `apps/web/src/features/leads/filtros.ts`, `apps/web/src/features/leads/filtros.test.ts`
- Modify: `apps/web/src/features/leads/LeadsPage.tsx`, `LeadDetalhePage.tsx`

- [ ] **Step 1: Teste do parse/serialize dos filtros na URL (falha primeiro)**

`apps/web/src/features/leads/filtros.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { fromSearch, toSearch } from './filtros';

describe('filtros ↔ URL', () => {
  it('ida e volta preserva os campos', () => {
    const f = { q: 'ana', tags: ['vip'], lifecycleStage: ['Lead'], oportunidade: true, page: 2, sort: 'name', dir: 'asc' as const };
    expect(fromSearch(new URLSearchParams(toSearch(f)))).toMatchObject(f);
  });
  it('URL vazia → defaults', () => {
    expect(fromSearch(new URLSearchParams(''))).toMatchObject({ page: 1, sort: 'lastConversionAt', dir: 'desc' });
  });
});
```

Run: `corepack pnpm --filter @rd/web test`
Expected: FAIL.

- [ ] **Step 2: Filtros + API**

`apps/web/src/features/leads/filtros.ts`:
```ts
import { leadsQuerySchema, type LeadsQuery } from '@rd/shared';

export type Filtros = Partial<LeadsQuery>;
export function fromSearch(sp: URLSearchParams): LeadsQuery {
  return leadsQuerySchema.parse(Object.fromEntries(sp.entries()));
}
export function toSearch(f: Filtros): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) {
    if (v === undefined || v === '' || v === null) continue;
    u.set(k, Array.isArray(v) ? v.join(',') : v instanceof Date ? v.toISOString().slice(0, 10) : String(v));
  }
  return u.toString();
}
```

`apps/web/src/features/leads/leadsApi.ts`:
```ts
import { useQuery } from '@tanstack/react-query';
import type { LeadDetail, LeadFacets, LeadRow, LeadsQuery, Page } from '@rd/shared';
import { api } from '../../lib/apiClient';
import { toSearch } from './filtros';

export const useLeads = (q: LeadsQuery) => useQuery({ queryKey: ['leads', q], queryFn: () => api.get<Page<LeadRow>>(`/leads?${toSearch(q)}`), placeholderData: (prev) => prev });
export const useFacets = () => useQuery({ queryKey: ['leads', 'facets'], queryFn: () => api.get<LeadFacets>('/leads/facets'), staleTime: 5 * 60_000 });
export const useLead = (id: string) => useQuery({ queryKey: ['lead', id], queryFn: () => api.get<LeadDetail>(`/leads/${id}`) });
```

- [ ] **Step 3: Página da lista**

`apps/web/src/features/leads/LeadsPage.tsx`:
```tsx
import { ArrowDown, ArrowUp } from 'lucide-react';
import { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { LeadsQuery } from '@rd/shared';
import { LEAD_SORTS } from '@rd/shared';
import { fromSearch, toSearch } from './filtros';
import { useFacets, useLeads } from './leadsApi';

const rel = (iso: string | null): string => {
  if (!iso) return '—';
  const h = (Date.now() - new Date(iso).getTime()) / 3_600_000;
  if (h < 1) return 'há minutos'; if (h < 24) return `há ${Math.floor(h)} h`; const d = Math.floor(h / 24); return d < 30 ? `há ${d} d` : new Date(iso).toLocaleDateString('pt-BR');
};

export function LeadsPage(): React.ReactElement {
  const [sp, setSp] = useSearchParams();
  const q = useMemo(() => fromSearch(sp), [sp]);
  const { data, isFetching } = useLeads(q);
  const { data: facets } = useFacets();
  const set = (patch: Partial<LeadsQuery>) => setSp(toSearch({ ...q, page: 1, ...patch }));
  const sortBy = (s: (typeof LEAD_SORTS)[number]) => set({ sort: s, dir: q.sort === s && q.dir === 'desc' ? 'asc' : 'desc' });
  const Th = ({ s, children }: { s: (typeof LEAD_SORTS)[number]; children: React.ReactNode }) => (
    <th onClick={() => sortBy(s)}>{children} {q.sort === s && (q.dir === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />)}</th>
  );
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <>
      <h1 className="page-title">Leads {data && <span className="muted" style={{ fontSize: 14 }}>· {data.total.toLocaleString('pt-BR')}</span>}</h1>
      <div className="toolbar">
        <input className="input" placeholder="Buscar nome, e-mail, telefone, empresa" defaultValue={q.q ?? ''} onKeyDown={(e) => { if (e.key === 'Enter') set({ q: (e.target as HTMLInputElement).value || undefined }); }} />
        <select className="input" value={q.lifecycleStage?.[0] ?? ''} onChange={(e) => set({ lifecycleStage: e.target.value ? [e.target.value] : undefined })}>
          <option value="">Estágio: todos</option>{facets?.lifecycleStages.map((s) => <option key={s.value} value={s.value}>{s.value} ({s.count})</option>)}
        </select>
        <select className="input" value={q.tags?.[0] ?? ''} onChange={(e) => set({ tags: e.target.value ? [e.target.value] : undefined })}>
          <option value="">Tag: todas</option>{facets?.tags.map((t) => <option key={t.value} value={t.value}>{t.value} ({t.count})</option>)}
        </select>
        <select className="input" value={q.conversao ?? ''} onChange={(e) => set({ conversao: e.target.value || undefined })}>
          <option value="">Conversão: todas</option>{facets?.conversoes.map((c) => <option key={c.value} value={c.value}>{c.value} ({c.count})</option>)}
        </select>
        <select className="input" value={q.oportunidade === undefined ? '' : String(q.oportunidade)} onChange={(e) => set({ oportunidade: e.target.value === '' ? undefined : e.target.value === 'true' })}>
          <option value="">Oportunidade: todos</option><option value="true">Sim</option><option value="false">Não</option>
        </select>
        <input className="input" type="date" value={q.de ? q.de.toISOString().slice(0, 10) : ''} onChange={(e) => set({ de: e.target.value ? new Date(e.target.value) : undefined })} title="Última conversão a partir de" />
        {sp.toString() && <button className="btn ghost" onClick={() => setSp('')}>Limpar</button>}
        {isFetching && <span className="muted">atualizando…</span>}
      </div>
      <table className="grid">
        <thead><tr><Th s="name">Nome</Th><th>E-mail</th><Th s="lifecycleStage">Estágio</Th><th>Tags</th><Th s="conversionsCount">Conv.</Th><Th s="lastConversionAt">Última conversão</Th><th>Cidade</th></tr></thead>
        <tbody>
          {data?.items.map((l) => (
            <tr key={l.id}>
              <td className="ellipsis"><Link to={`/leads/${l.id}${sp.toString() ? `?voltar=${encodeURIComponent(sp.toString())}` : ''}`}>{l.name ?? <span className="muted">(sem nome)</span>}</Link>{l.opportunity && <span className="chip" style={{ marginLeft: 6 }}>oport.</span>}</td>
              <td className="ellipsis muted">{l.email ?? '—'}</td>
              <td>{l.lifecycleStage ? <span className="chip stage">{l.lifecycleStage}</span> : '—'}</td>
              <td className="ellipsis">{l.tags.slice(0, 3).map((t) => <span key={t} className="chip">{t}</span>)}{l.tags.length > 3 && <span className="muted">+{l.tags.length - 3}</span>}</td>
              <td>{l.conversionsCount}</td>
              <td title={l.lastConversionAt ?? ''}>{rel(l.lastConversionAt)}</td>
              <td className="muted">{[l.city, l.state].filter(Boolean).join(' / ') || '—'}</td>
            </tr>
          ))}
          {data && data.items.length === 0 && <tr><td colSpan={7} className="muted">Nenhum lead com esses filtros.</td></tr>}
        </tbody>
      </table>
      <div className="pager">
        <span className="muted">Página {q.page} de {pages}</span>
        <button className="btn ghost" disabled={q.page <= 1} onClick={() => setSp(toSearch({ ...q, page: q.page - 1 }))}>‹</button>
        <button className="btn ghost" disabled={q.page >= pages} onClick={() => setSp(toSearch({ ...q, page: q.page + 1 }))}>›</button>
      </div>
    </>
  );
}
```

- [ ] **Step 4: Ficha do lead**

`apps/web/src/features/leads/LeadDetalhePage.tsx`:
```tsx
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useLead } from './leadsApi';

export function LeadDetalhePage(): React.ReactElement {
  const { id = '' } = useParams();
  const [sp] = useSearchParams();
  const { data: l, error } = useLead(id);
  if (error) return <div className="alert">Lead não encontrado.</div>;
  if (!l) return <p className="muted">Carregando…</p>;
  const voltar = sp.get('voltar');
  return (
    <>
      <p><Link to={`/leads${voltar ? `?${voltar}` : ''}`}>← Leads</Link></p>
      <h1 className="page-title">{l.name ?? '(sem nome)'} {l.opportunity && <span className="chip">oportunidade</span>}</h1>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: 16 }}>
        <div className="card">
          <dl className="kv">
            <dt>E-mail</dt><dd>{l.email ?? '—'}</dd>
            <dt>Telefone</dt><dd>{l.phone ?? '—'}</dd>
            <dt>Empresa</dt><dd>{l.company ?? '—'}</dd>
            <dt>Cargo</dt><dd>{l.jobTitle ?? '—'}</dd>
            <dt>Cidade</dt><dd>{[l.city, l.state].filter(Boolean).join(' / ') || '—'}</dd>
            <dt>Estágio</dt><dd>{l.lifecycleStage ?? '—'}</dd>
            <dt>Fit / interesse</dt><dd>{l.fit ?? '—'} / {l.interest ?? '—'}</dd>
            <dt>Tags</dt><dd>{l.tags.length ? l.tags.map((t) => <span key={t} className="chip">{t}</span>) : '—'}</dd>
            <dt>Criado no RD</dt><dd>{l.rdCreatedAt ? new Date(l.rdCreatedAt).toLocaleString('pt-BR') : '—'}</dd>
            <dt>UUID</dt><dd className="mono muted">{l.rdUuid}</dd>
          </dl>
          {Object.keys(l.customFields).length > 0 && (<>
            <h3>Campos personalizados</h3>
            <dl className="kv">{Object.entries(l.customFields).map(([k, v]) => <><dt key={`k${k}`}>{k.replace(/^cf_/, '')}</dt><dd key={`v${k}`}>{typeof v === 'object' ? JSON.stringify(v) : String(v ?? '—')}</dd></>)}</dl>
          </>)}
        </div>
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Conversões ({l.conversionsCount})</h3>
          <ul className="timeline" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {l.events.map((e) => <li key={e.id}><span className="muted mono" style={{ minWidth: 130 }}>{new Date(e.occurredAt).toLocaleString('pt-BR')}</span><span>{e.type === 'OPPORTUNITY' ? '★ ' : ''}{e.identifier}</span></li>)}
            {l.events.length === 0 && <li className="muted">Sem eventos.</li>}
          </ul>
        </div>
      </div>
    </>
  );
}
```

- [ ] **Step 5: Testes, typecheck, uso real**

```bash
corepack pnpm --filter @rd/web test
corepack pnpm --filter @rd/web typecheck
```
Expected: 2 testes PASS; sem erros. No navegador: `/leads` lista os leads carregados; filtros mudam a URL e a lista; clique abre a ficha com a linha do tempo; "← Leads" volta com os filtros.

- [ ] **Step 6: Commit**

```bash
```

---

### Task 13: Piso completo, CHANGELOG, PR

- [ ] **Step 1: Piso**

```bash
corepack pnpm -r typecheck && corepack pnpm lint && corepack pnpm test && corepack pnpm --filter @rd/api test:boot
```
Expected: tudo verde. Lint com `warn` de imports de tipo é aceitável; `error` não.

- [ ] **Step 2: CHANGELOG + README**

`CHANGELOG.md`:
```markdown
# Changelog

## 2026.09.27.1
- Criar conta e login (JWT + refresh em cookie HttpOnly).
- Conexão com o RD Station Marketing via OAuth (credenciais cifradas, state assinado).
- Carga inicial dos leads pela segmentação escolhida (detalhe + funil + conversões), retomável.
- Lista de leads com busca, filtros (estágio, tag, conversão, oportunidade, período), ordenação e paginação; ficha com linha do tempo.
```

`README.md`:
```markdown
# RD Insights

Painel para analisar os leads do RD Station Marketing. Design em `docs/superpowers/specs/`, regras em `CLAUDE.md`.

## Rodar local
1. `cp .env.example .env` e preencher `JWT_ACCESS_SECRET` (e `SECRETS_KEY`).
2. `corepack pnpm install && corepack pnpm db:up && corepack pnpm db:migrate:dev`
3. `corepack pnpm dev` → http://localhost:22500

## Conectar o RD
Criar um app em https://appstore.rdstation.com com callback `<APP_URL>/api/rd/callback`; colar client_id/secret em **Conexão RD**, autorizar, escolher a segmentação "todos os leads", iniciar a carga.
```

## Self-review (feito ao escrever)

- **Cobertura da spec (seções 1–4, 6, 7):** arquitetura ✔ (T1–T4, T10), dados ✔ (T3 — `WebhookLog`, `AiLog`, `SavedView` ficam para os planos 2/3, junto com os recursos que os usam), OAuth ✔ (T6–T7), carga inicial ✔ (T8), telas de auth/onboarding/leads/ficha ✔ (T10–T12), segurança ✔ (cifra, state HMAC, 404 por conta, throttle, senha ≥10), testes ✔ (cifra, auth, escopo, RdClient, sync, where, filtros). Fora: webhooks/delta/analytics/dashboard/IA/deploy/visões salvas/export CSV → Planos 2 e 3.
- **Tipos consistentes:** `RdTokens`, `RdClient.get(path, query)`, `RdConnectionService.client/marcarErro`, `RdSyncService.runFull(accountId, {fromCursor, runId?})`, `buildWhere`, `leadsQuerySchema` usados com as mesmas assinaturas em todas as tasks.
- **Sem placeholders:** todo passo de código traz o código.
