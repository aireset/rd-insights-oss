# RD Insights — design (2026-09-27)

> **Escopo atualizado:** cada conta pode monitorar várias segmentações. Um Lead continua único por conta/UUID; memberships N:N, reconciliação e fila persistente mantêm os dados atualizados. Consulte o [plano de multissegmentações](../plans/2026-09-28-plano-completo-multissegmentacoes.md) para os contratos detalhados.

Aplicação para analisar leads do **RD Station Marketing**, com autenticação, isolamento entre contas, sincronização pela API oficial e recursos de IA.

Decisões de produto: integração pela API oficial com OAuth; múltiplas contas isoladas desde o início; sincronização de segmentações por carga, webhook e reconciliação agendada.

## 1. Arquitetura

Monorepo pnpm (`packageManager pnpm@10`, Node ≥ 20):

| Pacote | Stack | Responsabilidade |
|---|---|---|
| `apps/api` | NestJS 11 + Fastify 5 + Prisma 6 + Postgres 16 + Redis 7 (BullMQ) | API, autenticação, sincronização e tarefas assíncronas |
| `apps/web` | Vite 6 + React 19 + react-router 7 + @tanstack/react-query 5 + lucide-react | interface web |
| `packages/shared` | tipos + schemas zod compartilhados | contratos compartilhados |

Portas locais: web 22500, api 22501, postgres 22506, redis 22509.

Módulos da aplicação, com escopo de conta (`accountId`):
`auth/` (JWT + refresh, argon2, guards, 2FA opcional), `common/{crypto-secrets, ssrf-fetch,
webhook-log, zod-validation.pipe, all-exceptions.filter, audit, throttle-tracker}`, `ai/llm/`
(config OmniRoute/OpenAI-compat, log, metering), `config/env.schema.ts`, `prisma/` (service),
web: `Badge, ChipFiltro, FiltrosAccordion, ActionMenu, ConfirmDialog, Field, DropdownPanel,
ErrorBoundary, Avatar, Breadcrumb, BulkActionBar`.

Documentação do projeto: `AGENTS.md`, `CLAUDE.md` e os guias em `docs/`.

## 2. Dados (Prisma)

Todo model de negócio tem `accountId` + índice. Sem soft-delete (YAGNI).

- **Account** — id, nome, createdAt.
- **User** — id, accountId, email (único global), senhaHash (argon2), role `admin | viewer`,
  createdAt, lastLoginAt.
- **RdConnection** — id, accountId (único: uma conexão por conta), clientId,
  clientSecret 🔐, accessToken 🔐, refreshToken 🔐, expiresAt, segmentationId ("todos os leads"),
  segmentationName, webhookUuids `string[]`, status `pending | active | reauth_required | error`,
  lastError, lastFullSyncAt, lastDeltaSyncAt.
- **Lead** — id, accountId, rdUuid (único por conta), name, email, phone, city, state, country,
  jobTitle, company, website, tags `string[]`, lifecycleStage, opportunity `boolean`, fit,
  interest, conversionsCount, firstConversionAt, lastConversionAt, rdCreatedAt,
  customFields `jsonb`, raw `jsonb` (último payload completo), aiSummary, aiScore
  `quente | morno | frio | null`, aiReason, aiAt, syncedAt.
- **LeadEvent** — id, leadId, accountId, type `CONVERSION | OPPORTUNITY`, identifier,
  occurredAt, payload `jsonb`. Único por (leadId, type, identifier, occurredAt).
- **SyncRun** — id, accountId, kind `full | delta | webhook | analytics`, startedAt,
  finishedAt, cursor (página atual, retomável), stats `jsonb` (lidos/criados/atualizados/erros),
  error.
- **WebhookLog** — armazena por conta (accountId, headers, body, status, processedAt).
- **AiLog / AiConfig** — registram uso e configuração de provider por instalação/conta.
- **SavedView** — id, accountId, userId, nome, filtros `jsonb` (visões salvas da lista).

🔐 = gravado via `encryptSecret` (AES-256-GCM, `SECRETS_KEY`); nunca volta ao frontend
(a API devolve `hasClientSecret: true`).

## 3. Sincronização com o RD

Cliente HTTP único `RdClient` (base `https://api.rd.services`, Bearer, `ssrf-fetch`), com
refresh automático (renova quando faltar < 1 h; token vive 24 h) e backoff exponencial em 429
(1 s, 2 s, 4 s… máx 60 s, 5 tentativas). 401 após refresh → `status = reauth_required` +
aviso na UI.

**(a) OAuth.** `GET /api/rd/connect` → redireciona a `https://api.rd.services/auth/dialog?client_id=…&redirect_uri=https://example.com/api/rd/callback&state=<accountId assinado>` →
`GET /api/rd/callback?code&state` → `POST /auth/token?token_by=code` → grava tokens cifrados,
`status = active`. Admin informa `clientId` + `clientSecret` uma vez na tela de conexão.

**(b) Carga inicial** (job BullMQ `rd-full-sync`, um por conta, não concorrente):
1. lista segmentações (`GET /platform/segmentations`) → admin escolhe a "todos os leads";
2. pagina `GET /platform/segmentations/{id}/contacts` (page/page_size máx da API);
3. para cada uuid, com concorrência 4: `GET /platform/contacts/uuid:X` +
   `GET /platform/contacts/X/funnels/default` (lifecycle_stage, opportunity, fit, interest) +
   `GET /platform/contacts/X/events?event_type=CONVERSION` (todas as páginas, 10/pg);
4. upsert `Lead` + `LeadEvent`; `SyncRun.cursor` avança por página → retomável após queda.
`company` só vem por webhook (limitação documentada da API) → fica null até o primeiro
webhook do lead.

**(c) Webhooks.** Ao ativar, cria via `POST /integrations/webhooks` dois subscriptions
(`WEBHOOK.CONVERTED` e `WEBHOOK.MARKED_OPPORTUNITY`, `entity_type CONTACT`,
`include_relations [COMPANY, CONTACT_FUNNEL]`) apontando para
`https://example.com/api/rd/webhook/<token>` (token aleatório por conta, 32 bytes, guardado
com hash; RD não assina → o segredo é a URL). Handler: valida token → grava `WebhookLog` →
responde 200 imediatamente → processa em job (`upsert` lead + evento, idempotente pela chave
única do evento). Endpoint precisa responder 2xx no cadastro (RD valida na criação).

**(d) Delta** (cron a cada 1 h por conta ativa): re-pagina a segmentação e refaz (b.3) só para
contatos com `last_conversion_date` > `lastDeltaSyncAt`. Cobre webhook perdido.

**(e) Analytics** (cron diário, cache 24 h): `GET /platform/analytics/conversions`
(por LP/form/popup, planos Pro ≤ 45 dias / Advanced) e `GET /platform/analytics/funnel`
(só Advanced). Se a API devolver erro de plano, a tela mostra "indisponível no seu plano do
RD" em vez de esconder o card (regra "recurso desligado aparece na tela").

## 4. Telas (apps/web)

- **Auth**: login, criar conta (cria `Account` + `User admin`), esqueci senha (SMTP; sem SMTP →
  modo adequado ao ambiente).
- **Onboarding** (primeiro acesso, sem conexão): passo 1 client_id/secret → passo 2 botão
  "Autorizar no RD" → passo 3 escolher segmentação → passo 4 carga inicial com barra de
  progresso (poll de `SyncRun`).
- **Leads**: tabela densa (nome, e-mail, estágio, IA, tags, conversões, última conversão,
  cidade), busca (nome/e-mail/telefone/empresa, `ILIKE` + índice trigram), filtros combináveis
  (tag, estágio, oportunidade, período de conversão, identificador de conversão, cidade/UF,
  classificação IA), ordenação por qualquer coluna, paginação server-side, visões salvas,
  export CSV do filtro atual.
- **Lead 360**: dados de contato, funil, tags, campos custom, linha do tempo de conversões
  (identificador + data), resumo e classificação IA com botão "regerar".
- **Dashboard**: novos leads por dia (7/30/90 d), leads por estágio do funil, top 10
  identificadores de conversão, tags mais frequentes, leads por cidade/UF, mapa de calor dia da
  semana × hora das conversões, "insight do dia" (IA). Cards de analytics do RD (conversões por
  ativo, funil) quando o plano permitir.
- **Pergunte à base**: chat com a IA sobre os leads (seção 5).
- **Configurações**: conexão RD (status, reautorizar, segmentação, webhooks, forçar sync),
  histórico de `SyncRun`, usuários da conta (convidar por e-mail, papel), IA (provider/chave —
  só admin).

Visual: seguir `frontend-design`/`impeccable` na hora de implementar; tabela densa é o
coração do produto, não card por lead.

## 5. IA first

Provider compatível com OpenAI configurado por cada instalação. O administrador configura suas próprias credenciais pela aplicação; a chave fica cifrada, não é distribuída com o projeto nem compartilhada entre instalações. Toda chamada registra origem, tokens e custo (`AiLog`).

1. **Classificação por lead** (job após cada upsert com conversão nova, e em lote na carga
   inicial com limite de N por minuto): entrada = nome, cargo, empresa, cidade, tags,
   estágio, lista de conversões com datas; saída JSON `{score: quente|morno|frio, reason, summary}`
   → `Lead.aiScore/aiReason/aiSummary`.
2. **Pergunte à base**: chat com tools tipadas, nunca SQL livre: `contar_leads(filtros)`,
   `listar_leads(filtros, limite ≤ 50)`, `tendencia(metrica, periodo, granularidade)`,
   `top(dimensao, periodo)`. Filtros são o mesmo schema zod da tela de Leads. Resposta cita os
   números e oferece "abrir na lista" (link com os filtros).
3. **Insight do dia** (cron diário por conta): 3 bullets sobre a última semana vs anterior
   (volume, melhores conversões, mudança de mix). Guardado, exibido no dashboard.

## 6. Segurança e erros

- Segredos só cifrados; `SECRETS_KEY` obrigatória em produção (boot falha sem ela).
- Escopo por conta em toda query (guard + regra do PROTOCOLO: model novo sem `accountId`
  precisa de decisão registrada; 404, nunca 403, para recurso de outra conta).
- Webhook: token na URL, rate-limit por IP, corpo bruto em `WebhookLog`, idempotência.
- `ssrf-fetch` em toda chamada de saída; nenhuma URL configurável pelo usuário além do RD.
- RD 401 → `reauth_required` + banner na UI; 429 → backoff; 5xx → retry do job, `SyncRun.error`.
- Dados pessoais nunca em query string nem em log (mascarar e-mail/telefone no `AiLog`).
- Senha: argon2id, mínimo 10 caracteres, rate-limit no login.
- TOTP é opcional por usuário: senha correta retorna challenge de 5 minutos e só o código TOTP ou recovery code consumido permite criar a sessão. Enrollment exige senha recente e confirmação de código; o segredo fica cifrado e os recovery codes ficam apenas como hash, com uso único. Código TOTP já aceito não pode ser reutilizado.
- Setup, confirmação, rotação e desativação consultam dados por `accountId` + `userId`; setup bloqueia sem `SECRETS_KEY`. Recovery codes são exibidos somente quando criados.

## 7. Testes

vitest na API: auth (login/refresh/2FA), cifra, escopo por conta (guard-as-test: todo model com
`accountId` aparece na lista de escopo), parser do payload do webhook (fixtures reais
mascaradas), sync incremental com `RdClient` mockado (paginação, retomada por cursor, 429),
classificação IA com provider mockado (JSON inválido → não grava). Web: vitest + testing-library
nas telas de Leads (filtros → query string) e Onboarding. E2E Playwright único: criar conta →
conectar (RD mockado) → carga → lista mostra os leads.

## 8. Implantação

A implantação é self-hosted com Docker Compose. Consulte [`docs/DEPLOY.md`](../../DEPLOY.md) para configurar o ambiente, fazer backup, compilar e iniciar a aplicação.

## Fora da v1 (YAGNI)

Import CSV, RD CRM, envio de conversões para o RD, publicar na App Store do RD, i18n, mobile,
múltiplas conexões RD por conta.
