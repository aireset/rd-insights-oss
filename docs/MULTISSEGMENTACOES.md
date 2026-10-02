# Sincronização de múltiplas segmentações

## Contrato e critérios

- Uma conexão OAuth por conta; catálogo e seleção múltipla isolados por `accountId`.
- Um Lead por `(accountId, rdUuid)`, eventos idempotentes e membership N:N com chaves compostas.
- `POST /api/rd/sync` aceita `{segmentIds?: string[]}`. Sem IDs, usa as selecionadas disponíveis. Retorna `runIds` e o primeiro `runId` para compatibilidade.
- Runs abertos são deduplicados por conta/segmento sob lock transacional curto. O job é identificado pela conta: a mesma seleção coalesce; uma seleção diferente enquanto o job está ativo retorna 409 antes de criar runs. BullMQ permite cinco jobs por worker, com contas diferentes avançando em paralelo. O lock por `accountId` cobre somente preparação/enfileiramento e a leitura inicial do worker, nunca chamadas RD. Falha de `queue.add` reverte os runs preparados.
- `GET /api/rd/sync/runs` retorna as últimas 100 execuções da conta, com segmento, status, fase, páginas e contadores. `/status` permanece como último run.
- Os IDs públicos de segmento são os IDs RD, sempre resolvidos dentro da conta. IDs inexistentes/estrangeiros/pausados em filtros ou disparo explícito retornam 404.

## Persistência e retomada

O scan grava a página inteira, os leads básicos, os memberships e o cursor na mesma transação. A geração é o ID do run. Uma falha de persistência reverte a página; retomar usa o mesmo run e começa depois da última página confirmada.

A descoberta termina antes do enriquecimento. Só a página terminal vazia permite marcar a cobertura como completa e confirmar ausências. Um vínculo precisa faltar em duas varreduras completas distintas para ser removido; uma tentativa interrompida não confirma ausência. Leads e eventos nunca são apagados por saída de segmento.

Detalhes e histórico têm checkpoints separados por UUID, consultados em lotes limitados. Uma falha conserva a fase/cursor e o status parcial. Freshness de detalhes e histórico é separada; sobreposição entre segmentos reutiliza dados confirmados na última hora. Um funil opcional com 404 preserva os campos já conhecidos; 401/429/5xx não são tratados como atualização bem-sucedida.

Desmarcar ou indisponibilizar um segmento pausa o run na próxima verificação, preservando a geração e o histórico. Reativar e disparar retoma essa geração. Uma resposta 404 na listagem sinaliza segmento indisponível; não equivale a uma lista vazia. Erro de um segmento não impede outro segmento válido, exceto reautorização global da conta.

## Lista e tela de conexão

A lista sem filtro continua sendo a união canônica da conta. `segmentIds` com `segmentMatch=any` usa união; `all` usa interseção. A consulta parte de Lead, portanto paginação e contagem não multiplicam leads por memberships. Somente segmentos selecionados e disponíveis participam dos filtros. A URL conserva a seleção e a operação.

Lista e ficha exibem os memberships ativos em badges. As facetas recebem os mesmos filtros da lista e contam leads distintos: tags repetidas e vários eventos da mesma conversão em um lead contribuem uma vez. A leitura ocorre em lotes de 500 leads. O retorno da ficha preserva os filtros. Em telas estreitas, o detalhe ocupa uma coluna e a rolagem horizontal fica restrita à tabela.

A conexão mostra cada execução, última conclusão, fase, erro e contadores por segmento. Não existe percentual sem denominador conhecido. Runs legados sem segmento não são atribuídos à seleção atual.

## Verificação local

Execute contra serviços descartáveis explicitamente indicados, nunca contra `.env` ou banco compartilhado:

```sh
NODE_ENV=test DATABASE_TEST_URL='<postgres descartável>' REDIS_TEST_URL='<redis descartável>' corepack pnpm test
corepack pnpm -r typecheck
corepack pnpm lint
corepack pnpm build
env -u REDIS_URL NODE_ENV=test corepack pnpm --filter @rd/api test:boot
git diff --check
```

`rd-segments.integration.spec.ts` cobre união A={u1,u2}/B={u2,u3}, filtros/facetas any/all, badges, eventos idempotentes, duas instâncias de fila, escopo, página interrompida, rollback transacional, duas confirmações de ausência, enriquecimento parcial, segmento pausado/removido e funil opcional.

Também cobre concorrência entre contas, coalescência da mesma seleção, 409 para seleção divergente e rollback com Redis indisponível durante o enqueue. A exclusividade usa [job IDs do BullMQ](https://docs.bullmq.io/guide/jobs/job-ids); a [concorrência do worker](https://docs.bullmq.io/guide/workers/concurrency) permite progresso entre contas.

As quatro migrações foram aplicadas em banco vazio. Também foi ensaiada a atualização de fixture legada: seleção antiga preservada com cobertura desconhecida, nenhum membership inventado, Lead/LeadEvent preservados e status histórico migrado.
