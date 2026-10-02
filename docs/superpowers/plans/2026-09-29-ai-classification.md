# Classificação de leads

## Contrato e aceite

- Entrada limitada aos atributos importados e eventos recentes do lead canônico; ausências explícitas. Memberships, datas de scan e PII direta não entram no hash. Provider/modelo/versão do prompt entram.
- Resposta JSON estrita: `score` quente/morno/frio, `reason`, `summary`. Falha, timeout ou resposta inválida preservam classificação anterior; resultado obsoleto não substitui fatos novos. Texto é sugestão de IA, não fato verificado.
- Outbox no Postgres e job BullMQ por tarefa, únicos por conta/lead/hash. Dispatcher consulta mudanças importadas em lotes limitados; eventos têm data de ingestão para detectar eventos antigos recebidos agora. Sem chamada RD neste fluxo.
- Política de preços por conta: USD por milhão de tokens de entrada/saída, sem preços implícitos. Ausência bloqueia chamadas com erro visível. Orçamento em centavos USD; reserva conservadora e limite por minuto atômicos sob lock curto por conta. Lock termina antes da chamada HTTPS. Uso desconhecido mantém reserva; não repetir automaticamente chamadas de resultado ambíguo.
- HTTPS resolve e valida todos os IPs antes de cada chamada e fixa IP validado no socket; hostname original no Host/TLS, sem redirects, timeout e tamanho de resposta limitados. Nunca registrar URL/chave/prompt/resposta em logs.
- AiLog registra origem, modelo, tokens e custo informado ou calculado. Reservas e tentativas persistem para orçamento e auditoria, sem texto livre do provider.
- UI exibe classificação, estado real, data/modelo, sugestão e dados usados; administração pode configurar preços e solicitar nova tentativa. Leitura escopada por conta; mutações admin-only; outra conta recebe 404.

## Limites de evidência

Mocks validam contrato e tratamento local; não provam compatibilidade de um provider externo. Preços são declarados pelo administrador. Reserva é estimativa conservadora baseada no limite local de entrada/saída; eventual custo real superior é registrado e bloqueia novas chamadas ao esgotar orçamento. Validação estrutural não prova ausência de alucinações.
