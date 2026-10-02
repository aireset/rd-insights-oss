# RD Insights completo — Implementation Plan

**Goal:** Trabalhar com várias segmentações do RD, compreender seus leads e conversões, comparar segmentos e manter dados atualizados automaticamente, entregando também o restante da v1.

**Architecture:** Uma conexão RD por conta, várias segmentações monitoradas e um lead por `(accountId, rdUuid)`. Relação N:N representa participação atual; BullMQ/Redis executa cargas, reconciliação, webhooks, atualização e IA com checkpoints no Postgres. Lista, exportação, dashboard e chat compartilham filtros e respeitam isolamento por conta.

**Tech Stack:** Node >= 20, pnpm, NestJS/Fastify, Prisma/Postgres 16, Redis 7, React/Vite. Adicionar BullMQ e integração Nest somente na tarefa de fila; não instalar outro scheduler concorrente.

**Spec:** `docs/superpowers/specs/2026-09-27-rd-insights-design.md`, ampliado pelo pedido de 28/09: várias segmentações, compreensão dos dados e atualização agendada. Este plano substitui a hipótese de uma segmentação única e o delta baseado exclusivamente em conversão recente.

## Global Constraints

- Segredos cifrados; nenhum token/client_secret em frontend, log, issue ou fixtures.
- Toda consulta e vínculo inclui accountId; recurso de outra conta retorna 404.
- Models novos classificados em ACCOUNT_SCOPED_MODELS ou GLOBAL_MODELS; SQL parametrizado registrado no guard.
- Lead único por conta/UUID, mesmo aparecendo em várias segmentações. Eventos idempotentes.
- Migração aditiva, backup pg_dump antes de migração publicada e ensaio em banco descartável; nunca usar banco compartilhado para testes destrutivos.
- Piso: `corepack pnpm -r typecheck && corepack pnpm lint && corepack pnpm test && corepack pnpm --filter @rd/api test:boot`.
- Não prometer campos, histórico, precisão temporal ou analytics indisponíveis na API/plano contratado.

## Decisões de produto e dados

1. Tela permite buscar, selecionar, adicionar, pausar e retomar várias segmentações; mostrar nome, contagem conhecida, atualização e erro por segmento.
2. Lista sem filtro mostra união dos leads importados da conta, uma vez cada. Filtro `segmentIds` usa união (`any`) por padrão e interseção (`all`) quando selecionada; nenhum resultado duplica lead.
3. Dashboard compara segmentos lado a lado e explicita sobreposição. Somar tamanhos de segmentos não produz total único da base.
4. Campos: contato, empresa quando fornecida, estágio, oportunidade, fit/interest, tags, campos customizados, conversões e oportunidades disponíveis, classificação/resumo IA e proveniência/freshness. Valor ausente não é zero.
5. Migração importa apenas configuração da segmentação antiga. NÃO atribuir todos os leads históricos a ela: o usuário pode ter trocado seleção antes. Membership começa desconhecida e é estabelecida por varredura válida.
6. Desmarcar segmento pausa monitoramento; não apaga leads ou eventos. Segmento removido no RD é sinalizado, não tratado como segmento vazio por erro.
7. Membership representa estado observado agora. Não alegar que lead pertencia a segmento no instante de uma conversão antiga. Evolução histórica começa com snapshots agregados após implantação.
8. Um SyncRun por segmento/carga, com cursor por página. Runs históricos mantêm segmentação nula. Refresh completo da união da conta também usa segmentId=null, kind=refresh, checkpoint JSON com afterLeadId (keyset estável), cutoffAt e passes; leads novos depois do cutoff entram por jobs prioritários ou próxima passagem. Status explícito: queued/running/completed/partial/failed; falha de enriquecimento não vira sucesso completo.
9. Cada scan tem geração própria. Persistir memberships vistas e checkpoint juntos; remover vínculos ausentes somente após scan completo, sem erro de listagem/persistência. Como API paginada pode mudar durante scan, confirmar ausência em duas varreduras completas antes de remover; erro intermediário não conta como confirmação.
10. Dados de membership e enriquecimento têm freshness separados. Falha ao buscar detalhe não pode apagar vínculo comprovado nem afirmar detalhe atualizado.
11. Mesmo UUID em segmentos diferentes reutiliza lead; enriquecimento deduplicado por conta/UUID e janela de atualização, sem guardar milhões de UUIDs em memória.
12. API analytics RD é global por conta/ativo; métricas por segmentação são calculadas da base local. Rotular origem, período, timezone e cobertura.

## Cron e execução automática

Horários são defaults operacionais configuráveis, não garantia de terminar toda a base dentro do intervalo. Datas em UTC; interface mostra timezone da conta (padrão America/Sao_Paulo). Escalonar disparos por conta.

| Processo | Disparo | Comportamento |
|---|---|---|
| Webhook | Assim que recebido | Persistir antes de responder 2xx; processamento em fila |
| Reconciliação de segmentos | A cada 1 hora | Todas as selecionadas; varrer membership e priorizar leads novos/conversões alteradas |
| Atualização de campos | Diariamente, em janela configurada para a conta | União de leads monitorados em round-robin; retomar cursor e respeitar orçamento |
| Catálogo de segmentações | Diariamente + atualização manual | Nomes, disponibilidade e novas opções |
| Analytics RD | Diariamente, em janela configurada | Cache de 24 h; erro de plano explícito |
| Insight diário | Após atualização de métricas | Gerar somente com cobertura/freshness informadas |
| Recuperação operacional | Ao subir worker + varredura periódica de runs órfãos | Reenfileirar checkpoint sem criar segunda execução |

- Uma execução de scan por conta, com exclusão distribuída e recuperação após crash; contas diferentes podem progredir.
- Disparo repetido encontra job em andamento e não acumula uma fila de cargas completas iguais.
- Limites por conta/endpoint; começar conservador (60 chamadas/min para contatos quando cota não foi confirmada), configurável e adaptado a 429. Não presumir que limiter global BullMQ equivale a limiter por conta.
- Respeitar Retry-After e remaining_time quando presentes; backoff com jitter em jobs atrasados, tentativas finitas e retomada manual.
- 401/reautorização pausa jobs da conta; 429 aguarda; erro transitório retenta; falha terminal fica visível.
- Alterações de nome/tags/empresa e saída de segmento podem ocorrer sem conversão: delta por data de conversão é otimização, nunca única fonte da verdade.
- Percentual apenas quando denominador válido; caso contrário mostrar páginas/leads processados e indicador indeterminado.

## Contratos entre microtarefas

Nomes abaixo são decisões para implementação; não descrevem endpoints já existentes.

- `RdSegmentation`: accountId, rdId, name, standard, selected, lastMembershipSyncAt, availability, membershipCoverage ('unknown'|'partial'|'complete'). Unique (accountId, rdId).
- `LeadSegmentMembership`: accountId, rdUuid, segmentId, lastSeenRunId, lastMissingRunId?, missingScans. Unique (accountId, segmentId, rdUuid), FKs compostas para Lead e RdSegmentation.
- `SyncRun`: acrescentar segmentId nullable, status, checkpoint/estatísticas separadas de membership e enriquecimento; cursor avança só após persistência. Refresh account-level usa checkpoint keyset e itens com falha ficam pendentes/retry; avanço não representa sucesso desses itens.
- `GET /api/rd/segmentations`: catálogo paginado/normalizado da conta; `PUT /api/rd/segmentations/selection`: `{segmentIds: string[]}`, conjunto pode ser vazio para pausar todas.
- `POST /api/rd/sync`: `{segmentIds?: string[]}`, ausência = selecionadas; resposta `{runIds: string[]}`. Compatibilidade temporária com runId singular no cliente antigo, documentada e testada.
- `GET /api/rd/sync/runs`: histórico paginado com filtro por segmento/status; endpoint status antigo permanece durante atualização.
- `SegmentFilter`: `{segmentIds?: string[], segmentMatch: 'any'|'all'}`; IDs deduplicados, validados na conta. Ausência/array vazio não restringe.
- `enqueueSync(accountId, segmentId, kind): Promise<{runId: string}>`; jobs nunca aceitam accountId derivado de payload público não autenticado.
- `reconcileSegment(accountId, segmentId, runId): Promise<void>`; separa descoberta de membership e refresh de detalhes.
- `refreshLead(accountId, rdUuid): Promise<void>`; idempotente e compartilhado entre full/delta/webhook.
- `buildWhere(accountId, query)` permanece fonte dos filtros de lista, CSV, dashboard e tools IA.
- Endpoint antigo de escolha única é adaptador temporário; não remover colunas legadas na mesma release da migração aditiva.

## Revisão funcional

- Lead em dois segmentos/duas contas: sem duplicação nem vazamento — T01/T05.
- Crash entre persistir página e cursor: retomada sem perda e sem exclusão falsa — T03/T04.
- Segmento muda durante paginação ou erro RD aparenta lista vazia: preservação e cobertura explícita — T04/T06.
- Mais de 500 eventos, mesma data ou payload parcial: histórico completo quando disponível e erro parcial visível — T06.
- Conta com limites baixos/base grande: cron não se sobrepõe e UI não promete atualização concluída — T03/T07/T08.

## Microtarefas implementáveis

Para cada mudança, escreva um teste de regressão quando necessário, implemente o menor ajuste que atende ao contrato e execute as verificações pertinentes. Serialize alterações de schema e migrations.

### T00 — Pré-requisitos
- [ ] Conferir compatibilidade da autenticação e do modelo de conta antes de introduzir memberships e tarefas assíncronas.
- [ ] Validar os fluxos afetados com banco e Redis descartáveis.

### T01 — Modelo multissegmentação e migração compatível
**Arquivos:** apps/api/prisma/schema.prisma; nova migration; apps/api/src/prisma/account-scope.ts/spec.ts; packages/shared/src/rd.ts.
**Contrato:** RdSegmentation + LeadSegmentMembership + SyncRun por segmento descritos acima.
- [ ] Testar duas contas com mesmo rdId/rdUuid: vínculo cruzado deve falhar; mesma conta em dois segmentos mantém um Lead.
- [ ] Implementar migração aditiva que semeia seleção legada, não memberships inferidas.
- [ ] Rodar migration em banco descartável com fixture legada; verificar leads/eventos preservados e guard de escopo.
- [ ] Commit/PR exclusivo; checkpoint de schema para tarefas dependentes.

### T02 — Catálogo, seleção múltipla e onboarding
**Arquivos:** rd-connection.controller/service/spec.ts; packages/shared/src/rd.ts; ConectarRdPage.tsx; rdApi.ts; teste de onboarding.
**Depende:** T01. **Contrato:** GET catálogo, PUT selection, adaptador singular.
- [ ] Testar catálogo com mais de uma página, IDs repetidos/inexistentes/estrangeiros e seleção vazia.
- [ ] Validar IDs contra catálogo autorizado; nomes vêm do RD, não do cliente; persistir seleção atomicamente.
- [ ] Substituir texto único por seleção editável múltipla, busca e estados de erro; reabrir seleção após onboarding.
- [ ] Testar selecionar A+B, pausar A, manter B; conferir teclado/mobile e preservação da conexão.

### T03 — Fila persistente e limitação por conta
**Arquivos:** apps/api/package.json; rd.module.ts; novos rd-jobs.service/processor/spec.ts; env.schema.ts; compose se necessário.
**Depende:** T00/T01. **Contrato:** enqueueSync; worker chama reconcileSegment/refreshLead.
- [ ] Testar dois disparos iguais, duas réplicas e reinício: uma execução por conta, jobs recuperáveis.
- [ ] Adicionar BullMQ/Nest, scheduler único e lock distribuído com ownership/renovação/liberação segura.
- [ ] Aplicar orçamento por conta a TODAS chamadas RD compartilhadas, incluindo OAuth refresh concorrente e analytics por endpoint.
- [ ] Testar 429 com headers/body, token expirado, Redis indisponível e morte de worker; manter erro/retomada observáveis.
- [ ] Provar recuperação em Redis/Postgres descartáveis; sem migrations no banco compartilhado.

### T04 — Scan multissegmentação, checkpoint e memberships
**Arquivos:** rd-sync.service.ts/spec.ts; rd-jobs.processor.ts; rd-mapper.ts quando necessário.
**Depende:** T01/T03. **Contrato:** reconcileSegment(accountId, segmentId, runId).
- [ ] Fixture A={u1,u2}, B={u2,u3}: três Leads, quatro memberships, eventos sem duplicação.
- [ ] Persistir página+cursor de forma recuperável; reinício na página 2 usa mesma geração e preserva páginas anteriores.
- [ ] Confirmar ausências em duas varreduras completas; falha/listagem parcial nunca remove vínculo.
- [ ] Separar membership bem-sucedida de detalhe parcial; não apagar lead quando deixa todos os segmentos.
- [ ] Testar desmarcar/remover segmento durante job, erro de uma página e cron repetido.

### T05 — Filtros e contagens por segmentos
**Arquivos:** packages/shared/src/leads.ts/test.ts; leads.service.ts/spec.ts; features/leads/filtros.ts/test.ts; LeadsPage.tsx; LeadDetalhePage.tsx.
**Depende:** T01/T04. **Contrato:** SegmentFilter + buildWhere reaproveitado.
- [ ] Testar any(A,B)=3 e all(A,B)=1 na fixture T04, totais independentes da paginação e sem vazamento.
- [ ] Mostrar segmentos de cada lead e filtro múltiplo persistido na URL; adicionar facetas restritas à seleção.
- [ ] Contar Leads distintos, não memberships; validação de segmento estrangeiro retorna 404.
- [ ] Verificar ordenação estável, navegação, estado vazio e largura mobile.

### T06 — Completude do dado e histórico
**Arquivos:** rd-client.ts/spec.ts; rd-sync.service.ts/spec.ts; rd-mapper.ts; shared/leads.ts; LeadDetalhePage.tsx.
**Depende:** T03/T04.
- [ ] Testar 501+ eventos e paginação de CONVERSION/OPPORTUNITY, duplicatas entre páginas e falha intermediária.
- [ ] Remover teto silencioso; persistir progresso em lotes e respeitar limites/cancelamento sem perder checkpoint.
- [ ] Distinguir dado ausente, indisponível por API/plano e falha temporária; não sobrescrever dado válido com null causado por erro de fetch.
- [ ] Exibir proveniência/última atualização, campos customizados e timeline completa disponível; nunca expor raw com segredos.

### T07 — Cron, reconciliação e atualização de campos
**Arquivos:** novos rd-scheduler.service/spec.ts; rd-jobs.service.ts; config e documentação.
**Depende:** T03/T04/T06.
- [ ] Testar relógio simulado: horário enumera todas selecionadas; conta pausada/reauth não inicia.
- [ ] Registrar schedules da tabela, sem duplicar em restart; usar cursor persistente e filas com prioridades. Refresh da união usa SyncRun account-level kind=refresh, segmentId=null e keyset afterLeadId com cutoffAt; leads que falham mantêm retry pendente e freshness antiga.
- [ ] Priorizar novo/alterado por conversão, mas refresh periódico cobre mudanças sem conversão.
- [ ] Testar janela longa maior que intervalo, falha parcial e retomada; sucesso de A não avança watermark de B.
- [ ] Permitir disparo manual da mesma rotina e mostrar próxima execução.

### T08 — Progresso, histórico e operação
**Arquivos:** shared/rd.ts; rd-sync.controller.ts; ConectarRdPage.tsx; nova tela de histórico e testes.
**Depende:** T03/T04/T07.
- [ ] Testar queued/running/partial/failed/completed, total desconhecido e erro em um de vários segmentos.
- [ ] Exibir páginas, leads lidos/atualizados/erros, segmento atual, última/próxima execução e motivo de pausa. Até primeira varredura válida, coverage=unknown/partial e contagem indeterminada, nunca zero inferido.
- [ ] Adicionar retentar/pausar com guarda admin; progresso indeterminado quando não há total confiável.
- [ ] Verificar que “concluído” exige estado efetivamente concluído, sem fallback 50%.

### T09 — Webhooks duráveis e idempotentes
**Arquivos:** novo rd-webhook.controller/service/spec.ts; schema/migration WebhookLog + segredo hashed; rd-jobs.service.ts.
**Depende:** T03/T06.
- [ ] Testar token inválido, payload malformado, duplicado, falha ao persistir e callbacks de registro.
- [ ] Registrar subscriptions de conversão/oportunidade idempotentemente; token aleatório 32 bytes, hash persistido, redaction de URL/log.
- [ ] Persistir recebimento antes de 2xx (<5 s); enqueue recuperável mesmo se Redis cair depois da gravação.
- [ ] Worker reutiliza refreshLead; oportunidade não vira conversão; vínculo de segmento só por varredura comprovada.
- [ ] Testar retry e isolamento; provar com sandbox autorizado, sem usar mocks como homologação real.

### T10 — Lista completa, visões salvas e CSV
**Arquivos:** shared/leads.ts; leads.service/controller/spec.ts; novo SavedView model; LeadsPage.tsx e API.
**Depende:** T05; classificação IA habilitada depois de T14.
- [ ] Testar filtros combinados, ordenação das colunas previstas e datas/timezone.
- [ ] Visões por conta/usuário persistem exatamente SegmentFilter e outros filtros; impedir acesso cruzado.
- [ ] CSV reutiliza buildWhere, pagina em stream e neutraliza formula injection; não carrega toda base na memória.
- [ ] Verificar contagem CSV/lista e índice de busca com consulta realista antes de adicionar índice trigram.
- [ ] Schema permite filtro IA, mostrando indisponibilidade até T14.

### T11 — Métricas locais por segmento e comparação
**Arquivos:** novos dashboard.module/controller/service/spec.ts; shared/dashboard.ts; DashboardPage.tsx.
**Depende:** T05/T06.
- [ ] Fixture fixa valida 7/30/90 dias, estágio, top conversões, tags, cidade/UF e heatmap com timezone.
- [ ] API usa SegmentFilter; comparar A/B com tamanho distinto, sobreposição e lead único total.
- [ ] Mostrar base sem dados/dado parcial, origem e freshness; comparar períodos iguais.
- [ ] Snapshots agregados diários começam agora; rotular filtro por membership atual, sem inventar coorte histórica.

### T12 — Analytics RD diário
**Arquivos:** novos rd-analytics.service/spec.ts; cache persistido por conta/tipo/período; dashboard UI.
**Depende:** T03/T07/T11.
- [ ] Testar cache 24 h, 401/429/5xx e ausência de permissão/plano sem esconder card.
- [ ] Consultar conversions/funnel apenas conforme capacidade; Pro conversions até 45 dias segundo referência específica.
- [ ] Marcar analytics como globais RD: não atribuir artificialmente métricas ao segmento selecionado.
- [ ] Testar cache segregado por conta e preservação de último dado com indicação de atraso.

### T13 — Configuração IA, segurança e custo
**Arquivos:** novos ai/llm, AiConfig/AiLog models, guards/cifra de segredos; settings UI.
**Depende:** T01; independente de T11.
- [ ] Config admin, provider OpenAI-compatible/OmniRoute, chave cifrada, limites de orçamento e erro de quota.
- [ ] Testar segredo não retornado, URL SSRF, logs sem PII e isolamento da config.
- [ ] Implementar módulos necessários neste repositório; cada instalação deve configurar suas próprias chaves e credenciais.
- [ ] Provider mock prova contrato; chamada real requer credencial autorizada e fica identificada separadamente.

### T14 — Classificação e resumo de lead
**Arquivos:** ai/lead-classifier.service/spec.ts; shared/leads.ts; LeadDetalhePage.tsx.
**Depende:** T06/T13.
- [ ] Testar JSON inválido, timeout, score fora enum e resposta sem números inventados: não sobrescrever classificação válida.
- [ ] Job por lead com conversão nova, hash de entrada para dedup, rate/budget configurável; botão regerar admin.
- [ ] Persistir score quente/morno/frio, reason, summary, data/modelo e metering.
- [ ] Habilitar coluna/filtro na lista; explicitar sugestão IA e dado usado.

### T15 — Insight diário por base/segmentação
**Arquivos:** ai/insight.service/spec.ts; scheduler; dashboard UI e persistência.
**Depende:** T07/T11/T13.
- [ ] Testar semana atual/anterior e zero dados; três bullets devem corresponder a métricas verificadas.
- [ ] Snapshot das métricas e escopo junto do texto; falha IA não impede dashboard.
- [ ] Gerar para segmentos monitorados dentro do orçamento; reutilizar resultado cacheado em navegação.

### T16 — Pergunte à base
**Arquivos:** ai/chat.controller/service/spec.ts; tools tipadas; ChatPage.tsx.
**Depende:** T05/T10/T11/T13.
- [ ] Tools contar_leads, listar_leads(limite<=50), tendencia e top reutilizam schema; nunca SQL arbitrário.
- [ ] Testar prompt injection, segmento de outra conta, query inválida, tool com limite excedido e budget.
- [ ] Resposta referencia números retornados e link “abrir na lista” com mesmos filtros.
- [ ] Contexto explicita segmento/período/freshness; não enviar base inteira ao provider.

### T17 — Recuperação de senha e controles auth
**Arquivos:** auth/password.service.ts; auth.controller/service/spec.ts; reset-token model; tela recuperar.
**Depende:** esquema/auth atual; paralelo às tarefas de dados.
- [ ] Token hashed, uso único/expiração, senha >=10, rate limit e resposta sem enumerar usuários.
- [ ] SMTP configurável; em produção sem SMTP indicar indisponibilidade ao operador, sem logar link/token sensível.
- [ ] Testar expiração, reutilização, revogação de sessões e registro público continuar fechado.
- [ ] Revisar refresh/guards/throttling e incluir 2FA opcional conforme design em subpasso próprio com teste TOTP/recovery.
- TOTP opcional: configuração autenticada, segredo cifrado, challenge sem sessão plena, proteção contra replay, recovery codes hashed de uso único e gerenciamento em Configurações → Segurança.

### T18 — Usuários e convites
**Arquivos:** módulo users, invite-token model; settings/UsersPage.tsx.
**Depende:** T17.
- [ ] Admin convida para própria conta; viewer não gerencia; superadmin segue política atual.
- [ ] Testar convite expirado/reutilizado/conta estrangeira, papel permitido e prevenção de remoção do último admin.
- [ ] Convite não reabre cadastro público nem transfere usuário de outra conta implicitamente.
- [ ] UI com estados enviados/pendentes/erro, auditoria de ação sem dados sensíveis.

### T19 — Implantação, backups e integração contínua
**Arquivos:** Dockerfile; Compose; docs/DEPLOY.md; procedimentos de backup.
**Depende:** pré-requisitos técnicos verificados.
- [ ] Distinguir validação CI, imagem publicada, migração, serviço iniciado e jornada pública.
- [ ] Automatizar backup antes de TODA migração e verificar restore descartável; retenção/backup diário.
- [ ] Deploy com health e rollback de imagem; migration incompatível não se resolve com rollback de imagem sozinho.
- [ ] Secrets pelo ambiente autorizado; sem expor env nem alterar outros serviços do host.
- [ ] Billing GitHub precisa resolvido pelo titular; não contornar com publicação marcada falsamente como CI verde.

### T20 — Aceitação integrada e operação assistida
**Arquivos:** E2E Playwright da jornada, fixtures mascaradas, docs operacionais.
**Depende:** contratos funcionais definidos nas tarefas anteriores.
- [ ] Jornada: login existente/convite → autorizar → selecionar A+B → carga → lista/ficha/filtros → cron → atualização.
- [ ] E2E com provider mock: duplicatas, 429, restart, erro parcial, reauth, mobile e isolamento.
- [ ] Validação RD real autorizada separada: IDs selecionados, amostra de contagens/campos/eventos, webhook e cron observados.
- [ ] Comparar número importado e cobertura com fonte; diferenças explicadas antes de declarar base completa.
- [ ] Registrar evidências por release: testes/CI/commit/PR/merge/deploy/health/jornada, cada estado separado.

## Fontes e limites verificados

- [Contatos de uma segmentação](https://developers.rdstation.com/reference/get_platform-segmentations-id-contacts-1) e [paginação](https://developers.rdstation.com/reference/mais-informa%C3%A7%C3%B5es): não há promessa de snapshot consistente ou feed completo de mudança de membership.
- [Eventos](https://developers.rdstation.com/reference/get_platform-contacts-uuid-events-1): paginação e tipos CONVERSION/OPPORTUNITY; disponibilidade real deve ser verificada na conta.
- [Webhooks](https://developers.rdstation.com/reference/webhooks), [payloads](https://developers.rdstation.com/reference/webhooks-payload-mkt) e [retry](https://developers.rdstation.com/reference/retries-logic): não cobrem toda edição manual; recepção durável e reconciliação continuam necessárias.
- [Limites RD](https://developers.rdstation.com/reference/limite-de-requisicoes-da-api), [conversions](https://developers.rdstation.com/reference/get_platform-analytics-conversions) e [funnel](https://developers.rdstation.com/reference/get_platform-analytics-funnel): referências divergem em elegibilidade de conversions; usar capacidade real/erro explícito, não pressupor plano.
- [BullMQ schedulers](https://docs.bullmq.io/guide/job-schedulers/) e [limiter](https://docs.bullmq.io/guide/rate-limiting): limiter global não fornece automaticamente isolamento de cota por conta.

## Fora do escopo

RD CRM, envio de conversões ao RD, importação CSV, App Store pública, i18n, mobile nativo e múltiplas conexões RD na mesma conta continuam fora da v1. “Todos os dados” significa todos os dados acessíveis e pertinentes pela API autorizada, com lacunas declaradas; não contornar permissões/limites.
