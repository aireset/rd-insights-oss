# Atualização completa rotativa

A reconciliação horária atualiza participação e eventos detectáveis. O refresh diário percorre os leads únicos das segmentações monitoradas e consulta detalhes, funil e páginas de conversões/oportunidades, mesmo sem conversão recente. Um lead em vários segmentos recebe uma atualização por ciclo da conta.

O scheduler diário usa BullMQ com IDs estáveis e horários configurados para a instalação. Reiniciar a API atualiza as agendas existentes. Cada conta reutiliza o mesmo jobId dos scans; uma solicitação agendada encontra o trabalho ativo e aguarda o próximo ciclo. Contas diferentes progridem em paralelo. Desligar `RD_REFRESH_ENABLED` remove somente as duas agendas diárias.

O run `refresh` tem `segmentId = null`. O checkpoint contém `cutoffAt`, segmentos do início do ciclo, `afterLeadId`, lead corrente, etapa e página. Memberships acrescentadas depois do corte ficam para o próximo ciclo; remoções ou segmentos pausados são respeitados na seleção atual. Isso é uma caminhada limitada pelo corte, não uma cópia imutável de toda a base. Não se usa `last_conversion_date` como filtro universal.

Cada tentativa HTTP da plataforma reserva uma chamada antes de sair, inclusive retries. O orçamento é configurável por conta e o catálogo mantém reserva independente. A janela de consumo reinicia à meia-noite UTC, exibida no fuso local pela tela. OAuth/token não entra nesse orçamento de plataforma. Uma queda após a reserva pode consumir uma chamada sem resposta: a contagem é conservadora. Esses limites internos não ampliam a cota do provedor nem medem chamadas de outras aplicações.

Etapas e páginas concluídas persistem antes do próximo HTTP. Ao acabar o orçamento, o run fica parcial e retoma no lote seguinte. Bases grandes podem levar vários dias. `lastRefreshAt` só muda ao encerrar o ciclo; a ficha continua mostrando a atualização e cobertura por endpoint. O catálogo grava última tentativa, último sucesso e erro seguro; falha não apaga a última lista completa.

Os jobs de scan não seguram lock global ou transação durante chamadas ao RD. Webhooks usam processamento próprio para não aguardar a fila de scans da conta.
