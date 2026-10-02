# Webhooks duráveis

## Contrato e aceite

- Duas subscriptions administradas: conversão e oportunidade, CONTACT, COMPANY/CONTACT_FUNNEL. Callback HTTPS com segredo aleatório de 32 bytes; banco guarda somente SHA-256. Registro recuperável e idempotente após falha parcial.
- Recebimento público autenticado pelo segredo, limitado por IP. JSON inválido e segredo inválido não criam trabalho. Resposta de sucesso apenas depois da gravação durável; indisponibilidade Redis não perde evento nem demora a resposta.
- WebhookLog por conta e identidade do evento, sem URL/headers/segredo. Duplicação de entrega é idempotente. Outbox recupera pendências após restart/Redis indisponível.
- Fila própria processa sem esperar refresh diário. Transação atualiza lead canônico/evento/conversões e conclusão do log. Oportunidade não vira conversão; memberships e cobertura completa só vêm dos scans. Payload tardio não substitui perfil mais novo.
- Estado real e falhas seguros visíveis ao operador; retry administrativo por conta.
- RED/GREEN, isolamento de tenants, falha de gravação/queue, recuperação/retry, migração legada, piso completo e revisão independente. Browser desktop/mobile com mocks separado de prova RD real.

## Decisões

O payload oficial traz o perfil atual e o evento: gravar diretamente evita esperar histórico paginado na fila do refresh. Não declarar histórico completo a partir de um webhook. A identidade usa tipo, contato, identificador e data do evento; a data de entrega é excluída. Serialização curta por lead ocorre somente dentro da transação de banco.

Outbox usa jobId estável e recuperação periódica limitada, sem lease próprio. Após cinco falhas de processamento, estado terminal visível exige retry administrativo. O recebimento continua disponível sem Redis.

## Fontes oficiais consultadas

- https://developers.rdstation.com/reference/post_integrations-webhooks
- https://developers.rdstation.com/reference/get_integrations-webhooks
- https://developers.rdstation.com/reference/updatesubscription
- https://developers.rdstation.com/es/reference/webhooks-payload-mkt
- https://developers.rdstation.com/reference/webhooks
