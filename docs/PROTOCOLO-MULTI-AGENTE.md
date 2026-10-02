# Protocolo multi-agente — RD Insights

Para qualquer agente (Claude Code, Codex, humano). O que quebra o trabalho do outro.

## 1. Invariantes que o CI cobra (guards-as-tests)

| Guard | Cobra |
|---|---|
| Model novo precisa de decisão de isolamento | todo `model` do `schema.prisma` está em `ACCOUNT_SCOPED_MODELS` ou `GLOBAL_MODELS` (`apps/api/src/prisma/account-scope.spec.ts`) |
| Raw SQL precisa de registro | `$queryRaw`/`$executeRaw` só com `// account-raw: <motivo>` e entrada no spec |
| Segredo novo precisa de cifra | campo gravado via `encryptSecret` e lido via `decryptSecret` |
| A fiação do Nest sobe | `test:boot` compila o `AppModule` sobre o `dist` |

## 2. A regra de ouro

Modelos globais (`User`, `Account`) não são filtrados por ninguém: corte manual por
`accountId` do usuário logado, sempre; recurso de outra conta → 404, nunca 403; nunca
`where: { accountId: x ?? undefined }` (undefined = sem filtro).

## 3. Convivência

Uma worktree por sessão; adicionar só os próprios arquivos; changelog sem conflito
(entrada nova no topo, versão date-based `YYYY.MM.DD.N`); PR incompleta = draft.

## 4. Definição de pronto

Código + testes + piso verde + docs afetados + CHANGELOG (se visível) + issue comentada.
