# Classificação com IA

O administrador configura provider, credencial cifrada e orçamento em `/configuracao/ia`; os centavos do limite representam USD. Em `/ia/classificacao`, informa preços em USD por milhão de tokens de entrada e saída, com até seis casas decimais. Zero precisa ser explícito. Sem ambos os preços nenhuma chamada é feita.

O dispatcher revisa leads pendentes por conta periodicamente; os limites de lote e intervalo são configuráveis. Seleciona a união distinta dos segmentos ativos; novas ingestões de eventos, enriquecimento e configuração alterada disparam avaliação. Datas de ingestão legadas recebem o horário da migração para permitir a primeira classificação; não representam a data histórica de recebimento. Memberships e datas de scan não entram no hash. O hash inclui fatos limitados, versão do prompt, provider, modelo e URL base; a URL não é devolvida no estado do lead nem registrada nos logs de uso.

A fila BullMQ `ai-classification` recebe somente IDs de conta/tarefa. A outbox Postgres recupera pendências após falha de publicação/Redis. O limite por minuto e o orçamento mensal são reservados sob lock transacional por conta; nenhuma conexão HTTP ocorre dentro do lock. Contas diferentes progridem simultaneamente. Respostas 429 adiam novos trabalhos da conta, preservando o maior prazo recebido. Chamadas com timeout, falha ambígua ou execução interrompida não são repetidas automaticamente: o operador vê a falha e solicita nova tentativa, que pode ter custo.

O orçamento do mês UTC soma custo confirmado e reservas ainda incertas. Custo USD informado pelo provider prevalece; sem custo, tokens informados × preços salvos determinam o valor (arredondado para cima em microdólares). Sem uso confirmado, a reserva permanece. A reserva usa bytes UTF-8 da entrada mais margem e limite de 1024 tokens de saída. É uma estimativa conservadora local, não uma garantia de faturamento externo: provider/modelo pode cobrar mais ou desrespeitar limites. Custo real superior é registrado e bloqueia novas reservas quando esgota o orçamento. Preços não são atualizados automaticamente.

Somente atributos importados limitados, tags, status de cobertura e até 20 eventos (tipo/data) compõem o prompt. Nome, e-mail, telefone, payload bruto e membership ficam fora. Empresa, cargo e tags podem conter texto inserido por terceiros: são tratados como dados não confiáveis, nunca como instruções. Não há conteúdo do prompt/resposta nos registros de uso. `AiLog.feature` informa a origem (initial/refresh/conversion/manual), junto de modelo, tokens e custo quando conhecidos; tarefas/tentativas guardam IDs, hashes, estados, códigos seguros e valores.

Saída estrita JSON (`score`, `reason`, `summary`) é validada e exibida como sugestão. Validação estrutural não comprova veracidade semântica nem ausência de alucinações. A classificação anterior permanece após falha e durante nova tentativa. Resultado de dados/configuração antigos não substitui dados mais novos. Admin pode solicitar novamente; viewer somente consulta. IDs de outra conta retornam 404, e as novas relações têm FKs compostas por conta.

O transporte HTTPS resolve todos os A/AAAA, valida os endereços e fixa o endereço aprovado no socket. Host e SNI mantêm o hostname original, a verificação TLS permanece ativa e redirects são recusados. Timeout de requisição: 20 segundos; resposta máxima: 64 KiB. Erros nunca incorporam corpo, URL ou chave.



## Uso na interface

`GET /api/ai/classification/distribution` (qualquer papel) devolve a contagem quente/morno/frio/sem classificação da conta e alimenta o card do Dashboard. `POST /api/ai/classification/all` (admin) enfileira os leads ainda sem classificação em segundo plano; o worker respeita o limite por minuto e o orçamento, e retoma pendências sozinho. Sem provider ativo, chave e preços, as telas mostram "IA não configurada".
