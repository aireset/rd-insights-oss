# Reconciliação recorrente

A reconciliação percorre todas as páginas de cada segmentação selecionada e disponível. Datas antigas de conversão nunca encerram a paginação de memberships. A ausência exige duas varreduras completas, preservando o lead e seus eventos canônicos.

Cada segmentação possui uma execução `delta` com cursor de página, etapa e último contato processado. `RdSegmentation.lastDeltaSyncAt` só avança quando toda a execução termina; usa o início da execução como limite conservador. `lastScanAt` registra apenas o término da leitura de memberships. Nenhum desses campos prova atualização completa de todos os campos do lead.

`last_conversion_date` é um sinal opcional de conversão. Um valor válido mais recente que a conversão local solicita leitura do histórico. Sem sinal válido, o histórico é revisitado quando não foi lido na última hora. Contatos novos recebem detalhe e histórico; campos de contatos já enriquecidos são atualizados pelo refresh completo. O marcador persistido `eventsPending` mantém trabalho de histórico pendente após falhas.

## Agendamento e concorrência

BullMQ mantém o scheduler `rd-reconciliation-hourly` na fila `rd-schedules`. A inicialização usa `upsertJobScheduler`, impedindo criação duplicada em reinícios ou réplicas. O dispatcher seleciona conexões ativas/com erro com segmentos selecionados, confere novamente sua elegibilidade e enfileira trabalho por conta. Conexões pendentes, apenas autorizadas ou aguardando nova autorização não são executadas automaticamente.

A fila de trabalho preserva um identificador estável por conta. Uma chamada automática encontra o trabalho já ativo e o reutiliza; não cria uma fila de execuções horárias atrasadas. Contas diferentes podem progredir em paralelo. O lock transacional por conta protege a publicação e é liberado antes das chamadas ao RD.

- `RD_RECONCILIATION_ENABLED`: `true` por padrão; `false` remove somente o scheduler desta reconciliação.
- `RD_RECONCILIATION_INTERVAL_MINUTES`: inteiro de 1 a 1440; padrão 60.
- Sem Redis, não há execução automática e o status informa indisponibilidade.
- A migração `20260928233000_recurring_membership_checkpoints` é aditiva, sem backfill de sucesso presumido.

## Contrato de status

`GET /api/rd/sync/schedule` usa a conta autenticada e retorna `enabled`, `state`, `intervalMinutes`, `nextRunAt`, `lastAttemptAt` e `lastCompletedAt`. A próxima execução vem do scheduler persistido, nunca de uma estimativa calculada pelo frontend. Contas pausadas ou serviço indisponível retornam `nextRunAt: null`. A tela **Sincronização** (`/sincronizacao`) apresenta agenda, últimas tentativas e falhas de reconciliação, separada do progresso da carga inicial.

`POST /api/rd/sync/reconcile` exige administrador e solicita reconciliação da própria conta. A resposta contém `runId` e `runIds`. `GET /api/rd/sync/runs` expõe andamento, parcial/falha, cursor e erro por execução. Um retry retoma o mesmo checkpoint; não reinicia toda a carga.

## Validação e limites

Valide persistência, concorrência e contratos com Postgres/Redis descartáveis e respostas simuladas do RD.



Referências oficiais: [Job schedulers](https://docs.bullmq.io/guide/job-schedulers/), [gerenciamento de schedulers](https://docs.bullmq.io/guide/job-schedulers/manage-job-schedulers), [identificadores de jobs](https://docs.bullmq.io/guide/jobs/job-ids).
