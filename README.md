# RD Insights

Aplicação self-hosted para analisar leads do RD Station Marketing, com sincronização pela [API oficial](https://api.rd.services).

## Requisitos

- Node.js 20 ou superior e Corepack.
- Docker Engine com Docker Compose.
- Uma aplicação registrada no RD Station Marketing para OAuth.

## Desenvolvimento local

```bash
cp .env.example .env
corepack pnpm install
corepack pnpm db:up
corepack pnpm db:migrate:dev
corepack pnpm dev
```

A interface fica em `http://localhost:22500` e a API em `http://localhost:22501`. Configure segredos locais no `.env`; nunca os commite.

## Integração RD

Registre um aplicativo no [RD Station](https://appstore.rdstation.com), configure o callback como `<APP_URL>/api/rd/callback` e informe `RD_CLIENT_ID` e `RD_CLIENT_SECRET` no ambiente ou conecte a conta pela interface. A URL base da API é `https://api.rd.services`.

## Usuários e operação

Consulte [gestão de usuários](docs/USERS.md), [sincronização de múltiplas segmentações](docs/MULTISSEGMENTACOES.md) e [implantação self-hosted](docs/DEPLOY.md).

## Licença

[MIT](LICENSE).
