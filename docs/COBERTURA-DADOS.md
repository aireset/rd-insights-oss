# Cobertura e atualização dos dados

Uma conversão recente não comprova atualização de todos os campos. A ficha do lead usa `enrichedAt` para a última atualização completa dos detalhes e `historySyncedAt` para a última leitura completa dos endpoints de conversões e oportunidades. Uma nova tentativa com erro preserva esses timestamps.

`Lead.dataCoverage` guarda apenas metadados de quatro fontes: detalhes, funil, conversões e oportunidades. Cada uma informa `unknown`, `available`, `partial` ou `unavailable`, a data da tentativa e um motivo seguro. `unavailable` requer resposta definitiva 403/404; não significa automaticamente restrição de plano. Falhas temporárias ficam parciais. Legados recebem `{}` na migração e são apresentados como desconhecidos, sem inferir sucesso de datas anteriores.

Campos explicitamente omitidos da resposta bem-sucedida são marcados como não fornecidos. Isso difere de fonte ainda não consultada. Valores antigos continuam visíveis quando um endpoint fica indisponível, acompanhados da cobertura atual. A API não expõe o JSON bruto do RD para oferecer esse estado.

Quando o histórico de conversões termina, seus eventos são preservados mesmo se oportunidades falhar em seguida. A execução permanece parcial e a data de histórico completo não avança. O funil 404 continua opcional e preserva os valores anteriores, agora com indisponibilidade explícita.

`GET /api/rd/sync/coverage` consulta somente o banco da conta autenticada. Cada segmento apresenta cobertura da leitura de participação, `lastScanAt` e último sucesso da reconciliação (`lastDeltaSyncAt`). Uma leitura completa de participação não implica atualização completa dos campos dos leads.
