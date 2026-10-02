# Changelog

## [Unreleased]
- Prepara publicação open source: documentação genérica, exemplos anonimizados e deploy local sem infraestrutura privada.
- Classificação por IA: badge quente/morno/frio na lista de leads, card de distribuição no Dashboard, botão Classificar todos (lote com limite por minuto e retomada) e aviso "IA não configurada" quando o provider está desligado; ficha tem o botão Reclassificar. (#12)
- Recuperação de senha (`/auth/forgot`, `/auth/reset` e rotas `password-reset/*`) responde 200 em vez de 201. (#9)
- Usuários da conta: administradores reenviam ou cancelam convites e removem membros (nunca a si mesmos nem o último administrador); testes cobrem isolamento entre contas e bloqueio do viewer em rotas de escrita. (#10)
- CI de PR e main: typecheck, lint, testes (com Postgres e Redis), boot do Nest, migrations em banco limpo e build do web em um único check `validate`. (#5)
- Recuperação de senha: a tela de login avisa quando o envio de e-mail (SMTP) não está configurado; sem SMTP o servidor só registra o envio em log, com o token mascarado. (#9)
- Filtro de UF em Leads não derruba mais a página ao digitar só a primeira letra. (#80)
- Layout: o fundo da barra lateral ocupa toda a altura em páginas longas e o conteúdo não fica sob a barra inferior no celular. (#76)
- Sincronização exibe "Última atualização automática" da reconciliação horária. (#75)
- Tempo real: a tela Sincronização mostra Tempo real ativo/inativo com o botão Ativar tempo real; a conexão registra os webhooks do RD ao escolher segmentações, e a reverificação reconhece assinaturas listadas em minúsculas pelo RD sem duplicá-las. (#74)
- Histórico de sincronizações com paginação e filtros por segmento e status. (#8)
- Interrupções definitivas da fila aparecem como parciais, mantendo o checkpoint para retomada após reinícios. (#20)
- Container encaminha SIGTERM ao NestJS para encerrar o worker BullMQ corretamente. (#20)
- Chat recebe o contexto dos segmentos, cobertura, atualização e fuso dos dados consultados. (#14)
- Salva snapshots diários das métricas e insights por conta e segmentação monitorada.
- Onboarding permite atualizar manualmente o catálogo de segmentações pelo RD e acompanha a execução em fila. (#7)

- Dashboard aplica o período de 7, 30 ou 90 dias às conversões e ao heatmap, usa America/Sao_Paulo em datas e horários e identifica distribuições de estado atual. (#13)
- Adiciona o chat Pergunte à base com consultas tipadas de leads, filtros por segmentação e link para abrir a lista correspondente.
- Dashboard exibe estatísticas globais do RD Station, com cache diário por conta e aviso quando os dados ficam desatualizados ou o plano não libera a API.

## 2026.09.29.4
- Adiciona autenticação TOTP opcional, códigos de recuperação de uso único e configuração em Segurança.

## 2026.09.29.3
- Carga e atualização diária aceitam o score `fit` numérico retornado pelo RD, usando a mesma validação de funil.

## 2026.09.28.8
- Eventos do RD são registrados antes da resposta e processados em fila própria, sem duplicar leads ou conversões em reentregas.
- Sincronização mostra recebimento, processamento, pendências e falhas, com configuração e nova tentativa para administradores.
- Respostas antigas do scanner não substituem perfis recebidos por webhook; o histórico canônico preserva contagens durante execuções simultâneas.

## 2026.09.28.7
- Refresh diário percorre leads únicos com orçamento por conta e retomada por etapa e página entre lotes.
- Catálogo de segmentações ganha atualização diária; sincronização mostra agenda, consumo e último sucesso sem prometer conclusão em 24 horas.

## 2026.09.28.6
- Ficha do lead separa a última atualização de dados e de histórico da disponibilidade de cada fonte do RD.
- Sincronização apresenta cobertura e última leitura por segmento; registros antigos permanecem desconhecidos até uma consulta comprovada.

## 2026.09.28.5
- Reconciliação automática revisita todas as segmentações monitoradas a cada hora, com retomada individual após falhas.
- Memberships e conversões recentes são atualizados sem duplicar leads; refresh completo de campos permanece separado.
- A API informa a próxima execução registrada na fila e permite solicitar reconciliação manual.

## 2026.09.28.4
- Carga manual percorre várias segmentações com memberships, leads canônicos, retomada por etapa e progresso individual.
- Saídas de segmento exigem duas varreduras completas; pausar preserva leads e histórico.
- Lista filtra união/interseção de segmentos ativos sem duplicar leads; filtros permanecem na URL.
- Facetas respeitam os filtros e contam leads únicos; lista e ficha mostram memberships ativos e se adaptam a telas estreitas.

- Leads: filtros de cidade, UF, intervalo inclusivo de conversão no fuso padrão America/Sao_Paulo e classificação IA persistidos na URL e na consulta server-side.
- Exportação CSV da lista respeita filtros e segmentos selecionados, inclui a base inteira e protege células contra fórmulas de planilha.
- Visões salvas ficam privadas por usuário, restauram filtros e podem ser removidas.
- Busca parcial de nome, e-mail, telefone e empresa recebe índices trigram PostgreSQL.
- Carga RD agora entra em fila persistente, retoma checkpoints após reinício e expõe prontidão de Postgres, Redis e worker.
- Dashboard informa origem das credenciais, cobertura de memberships e horários registrados por segmento.
- Dashboard inicial mostra novos leads por dia em 7, 30 ou 90 dias, filtrados pela união/interseção das segmentações selecionadas.
- Dashboard detalha estágios, conversões, tags, localidades e horários de conversão para os leads selecionados.
- Dashboard compara duas segmentações pela associação atual, com tamanhos, sobreposição e união de leads únicos.

## 2026.09.28.3
- Onboarding permite cadastrar múltiplas segmentações e indica que a carga ainda processa apenas uma.
- Progresso não inventa percentual; mostra etapa e contadores quando o backend os informa.

## 2026.09.29.2
- Carga do RD mais gentil com o limite (429): 2 leads em paralelo, até 8 tentativas com espera crescente (até 60 s) e sorteio para não bater junto.
- A barra da carga inicial mostra o total de páginas do RD ("página 3 de 12") e, se o RD não informar, vira uma barra animada em vez de 50% fixo.
- Visual novo com tema claro: tema claro, fonte Montserrat, menu lateral, cartões e telas de Login, Registrar, Leads e Conexão RD (celular com barra inferior).
- Lista de leads em um cartão por lead, com Data de entrada, Última alteração (, ordenáveis) e todas as tags visíveis.
- A ficha do lead abre num popup sobre a lista (; Esc ou clique fora fecha);  redireciona para ele.

## 2026.09.29.1
- Carga inicial destravada: o RD devolve `fit` numérico e a gravação do lead falhava; agora é convertido.
- Chamadas ao RD têm timeout de 30 s (com nova tentativa) e espera de 429 limitada a 2 min.
- Sincronização interrompida por reinício do servidor aparece como "Interrompido" e o botão vira "Retomar sincronização" (continua da última página).
- A tela mostra progresso só se a carga está rodando de fato, e exibe o primeiro erro quando há falhas.

## 2026.09.28.4
- Onboarding exibe etapas e contadores reais da carga quando disponíveis; a UI por etapa depende do merge da PR #29.
- Convites por e-mail de uso único e sete dias, gestão de papéis por conta e proteção do último administrador; cadastro público permanece fechado.

## 2026.09.28.3
- Progresso da carga inicial usa percentual apenas com total de páginas confiável; sem total, mostra andamento e contadores, mantendo conclusão e erro visíveis.
- Recuperação de senha com token de uso único/expiração, revogação de refresh tokens e SMTP configurável; cadastro público segue fechado.

## 2026.09.28.2
- Cadastro fechado por padrão (`REGISTRATION_OPEN=false`); só abre com a env, para o primeiro usuário do banco ou para o e-mail do super admin.
- Super admin (`SUPER_ADMIN_EMAIL`): promovido automaticamente no registro ou no primeiro login se a conta já existir.
- Link "Criar conta" só aparece no login quando o cadastro está aberto.

## 2026.09.27.1
- Criar conta e login (JWT + refresh em cookie HttpOnly).
- Conexão com o RD Station Marketing via OAuth (credenciais cifradas, state assinado).
- Credenciais do RD também pelo `.env` (fallback), com origem exibida no onboarding.
- Carga inicial dos leads pela segmentação escolhida (detalhe + funil + conversões), retomável.
- Lista de leads com busca, filtros (estágio, tag, conversão, oportunidade, período), ordenação e paginação; ficha com linha do tempo.
