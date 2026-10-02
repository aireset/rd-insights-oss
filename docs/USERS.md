# Usuários e convites

Administradores gerenciam os membros da própria conta em **Usuários**. Convites aceitam os papéis `admin` e `viewer`, expiram em sete dias e são vinculados ao endereço de e-mail globalmente único do usuário. O token não é salvo em texto puro e só pode ser consumido uma vez. A conta precisa manter ao menos um administrador.

O aceite cria o usuário diretamente na conta e no papel escolhidos pelo administrador. Isso não abre o cadastro público: `POST /api/auth/register` continua sujeito a `REGISTRATION_OPEN` e às exceções de bootstrap já existentes. Um e-mail já cadastrado não pode ser convidado para outra conta.

Reenviar um convite gera token novo e prazo de sete dias (o link anterior deixa de valer); cancelar apaga o convite. Remover um membro apaga o usuário da conta (e os convites que ele criou); não é permitido remover a si mesmo nem o último administrador. Rotas de escrita sem `@RequireAdmin` ficam restritas a uma lista explícita em `apps/api/src/auth/admin-routes.spec.ts`.

O envio usa o SMTP configurado para recuperação de senha (`SMTP_HOST`, `SMTP_FROM` e opções SMTP em `.env`). Se não houver transporte disponível, o convite não é entregue e a tela mostra erro para o administrador. O link/token não é escrito no log.

## Verificação de integração

O teste HTTP opcional `apps/api/src/users/users.e2e.spec.ts` exige `TEST_DATABASE_URL` apontando para um banco descartável cujo nome contenha `test` ou `disposable`; o teste recusa outros nomes. Aponte também `DATABASE_URL` para esse mesmo banco, aplique as migrations e rode:

```bash
corepack pnpm --filter @rd/shared build
TEST_DATABASE_URL="postgresql://test:test@127.0.0.1:55432/rd_invitations_test" DATABASE_URL="postgresql://test:test@127.0.0.1:55432/rd_invitations_test" corepack pnpm --filter @rd/api exec vitest run src/users/users.service.spec.ts src/users/users.e2e.spec.ts
```

Os testes de interface ficam em `apps/web/src/features/settings/UsersPage.test.tsx` e `apps/web/src/features/auth/AcceptInvitePage.test.tsx`.
