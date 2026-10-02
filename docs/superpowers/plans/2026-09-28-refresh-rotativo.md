# Atualização rotativa de dados

## Aceites e decisões

- Uma execução `refresh` por conta, `segmentId = null`, mesma exclusão de scans já oferecida pelo jobId da conta. Contas distintas continuam concorrentes.
- União canônica por `Lead.id`, memberships com `firstSeenAt <= cutoffAt`, seleção capturada no início e elegibilidade atual respeitada. Entradas posteriores ficam para o próximo ciclo. Remoções/pausas não ressuscitam contatos.
- Checkpoint persistente: `afterLeadId`, `cutoffAt`, lead corrente, etapa e página. Não carregar respostas RD em `SyncRun.stats`. Com orçamento de uma chamada, lotes seguintes ainda avançam.
- Orçamento diário de chamadas da plataforma reservado atomicamente por conta antes do HTTP, incluindo retries. OAuth/token não consome esse orçamento de plataforma. Consumir reserva antes do HTTP é conservador em crash.
- Nenhum watermark de refresh completo avança em resultado parcial, pausa ou erro. Cada etapa mantém a cobertura por endpoint.
- Scheduler nativo BullMQ idempotente em restart, horários em America/Sao_Paulo, sem backlog por conta. Refresh entrega lotes limitados; webhook futuro usa processamento imediato separado, sem aguardar este scan terminar.
- Catálogo diário mantém lista conhecida em falha e expõe última tentativa/sucesso/erro. Não inferir atualização de campos por última conversão.
- Status/UI mostra próxima tentativa real, checkpoint, consumo/orçamento e última conclusão. Não promete conclusão em 24 horas.

## Validação

RED/GREEN: união sobreposta, lead sem conversão recente, orçamento 1 e suficiente, retry debitado, restart no meio do lead/histórico, mudança de seleção após cutoff, pausa/reauth, falha parcial sem avanço, catálogo com falha preservando dados e exclusão por conta com paralelismo entre contas. Migração em banco vazio e legado descartáveis; testes completos, typecheck, lint, build, boot-check, diff-check. Browser com mocks locais separado de qualquer homologação RD.

Documentação oficial consultada: [BullMQ Job Schedulers](https://docs.bullmq.io/guide/job-schedulers/) e [Job IDs](https://docs.bullmq.io/guide/jobs/job-ids), compatíveis com BullMQ 6.3.9 instalado.
