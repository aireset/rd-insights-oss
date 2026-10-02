# Webhooks do RD Station Marketing

O painel **Sincronização → Eventos em tempo real** apresenta o registro das subscriptions, a disponibilidade do processamento, entregas pendentes e falhas. O administrador pode registrar/verificar os dois eventos e tentar novamente um evento com falha. Leitores não alteram configuração.

## Recebimento e processamento

O callback exige um segredo aleatório de 32 bytes. Só seu hash SHA-256 fica no banco. O segredo da URL não aparece na resposta administrativa, no estado da fila nem nos logs da aplicação. O registro usa HTTPS e as subscriptions `WEBHOOK.CONVERTED` e `WEBHOOK.MARKED_OPPORTUNITY`, com as relações COMPANY e CONTACT_FUNNEL.

A autenticação do callback é independente da sessão do usuário. O limite é de 300 requisições por IP por minuto. Uma entrega válida é gravada no Postgres antes da resposta HTTP 200. Se essa gravação falhar, a resposta é 503, para permitir reenvio. JSON de evento inválido recebe 400; segredo incorreto recebe 401. Um POST vazio autenticado recebe 200 como verificação de conectividade, sem inventar um lead ou evento.

O banco funciona como caixa de saída durável: uma falha no Redis não perde a entrega. Um publicador procura até 100 registros pendentes a cada 30 segundos e ao iniciar. Identificadores estáveis no BullMQ deduplicam a publicação. A fila `rd-webhooks` é separada da fila de scans, permitindo processar enquanto um refresh diário está ocupado. O evento e a conclusão do registro são gravados na mesma transação.

Cinco falhas de processamento tornam o registro uma falha terminal visível. A tentativa administrativa zera as tentativas do registro daquela conta. O estado público dessa operação contém apenas tipo, data, tentativas e identificador interno; o payload de auditoria fica restrito ao banco.

## Semântica dos dados

Uma entrega repetida não cria outro lead nem outro evento. A identidade usa conta, contato, tipo, identificador e data do evento; a data de entrega não muda essa identidade. Oportunidades são registradas separadamente de conversões.

Campos presentes no payload atualizam o perfil quando a data do evento não é anterior ao perfil já enriquecido ou recebido por webhook. Campos ausentes permanecem preservados. Essa atualização não confirma leitura completa do histórico, não altera datas de enriquecimento/histórico completo e não cria participação em segmentos. A reconciliação continua responsável pelas memberships.

Consultas RD iniciadas antes de um webhook não substituem o novo perfil ao terminar: a gravação compara uma versão monotônica do perfil, inclusive quando eventos distintos têm a mesma data. Scans e webhooks também coordenam as gravações de eventos por lead e derivam os agregados do mesmo histórico canônico, evitando perder contagens durante processamento simultâneo.

RD não dispara esses webhooks para toda alteração manual ou importação. Por isso eles complementam, mas não substituem, reconciliação e refresh. Datas de recebimento e processamento são distintas da data de conversão.

## Registro recuperável

O registro administrativo serializa apenas o cadastro de subscriptions daquela conta. O hash é confirmado no banco antes de chamar o RD, permitindo o callback durante a criação. Ao repetir o registro, URLs próprias retornadas pelo RD recuperam o segredo apenas em memória, mediante verificação do hash; subscriptions existentes são atualizadas. IDs removidos no provedor não são mantidos como ativos. Uma falha parcial fica visível e pode ser corrigida repetindo o registro.

## Validação e implantação

Os testes locais usam payloads fictícios e Postgres/Redis descartáveis. Incluem entrega concorrente, isolamento entre contas, falha de gravação, retomada da fila e processamento durante refresh ocupado. Isso não comprova registro/handshake no RD real.

Configure o proxy para não registrar o caminho secreto de `/api/rd/webhooks/`. Registre e verifique as subscriptions pela interface administrativa após configurar domínio e TLS.

Referências: [serviço de webhooks](https://developers.rdstation.com/reference/webhooks), [criar subscription](https://developers.rdstation.com/reference/post_integrations-webhooks), [atualizar subscription](https://developers.rdstation.com/reference/updatesubscription), [payload Marketing](https://developers.rdstation.com/es/reference/webhooks-payload-mkt).
