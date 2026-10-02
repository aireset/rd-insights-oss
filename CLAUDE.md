# Guia do projeto — RD Insights

Aplicação self-hosted para analisar leads do RD Station Marketing por meio da API oficial.

## Stack
- Monorepo pnpm (`corepack pnpm`), Node.js 20 ou superior.
- `apps/api`: NestJS, Fastify, Prisma e PostgreSQL; Redis/BullMQ para tarefas.
- `apps/web`: Vite, React e React Router.
- `packages/shared`: tipos e schemas compartilhados.

## Desenvolvimento
```bash
corepack pnpm install
cp .env.example .env
corepack pnpm db:up
corepack pnpm db:migrate:dev
corepack pnpm dev
```

Consulte `README.md` para configuração local e os guias em `docs/` para os contratos funcionais.

## Segurança
- Nunca versione `.env`, tokens ou credenciais.
- Segredos de integração devem permanecer cifrados; não os exponha à interface.
- Toda consulta de dados de conta deve respeitar seu escopo de autorização.
- Não registre tokens, dados pessoais ou corpos sensíveis em URLs e logs.
