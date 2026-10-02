# Implantação self-hosted

Este guia descreve uma instalação própria com Docker Compose. Escolha um host, configure domínio, TLS, firewall e armazenamento persistente conforme sua infraestrutura.

## Configuração

O `.env.example` serve ao desenvolvimento local. Para o host de produção, crie um `.env` próprio e defina os valores abaixo; não reutilize os valores locais. Use segredos gerados para a instalação, guarde o arquivo fora do controle de versão e restrinja suas permissões. Os exemplos mostram nomes e formatos, sem credenciais reais.

```dotenv
NODE_ENV=production
APP_URL=https://app.example.com
CORS_ORIGIN=https://app.example.com
DATABASE_URL=postgresql://<usuario>:<senha-forte>@postgres:5432/<banco>
POSTGRES_USER=<usuario>
POSTGRES_PASSWORD=<senha-forte>
POSTGRES_DB=<banco>
JWT_ACCESS_SECRET=<segredo-aleatorio-forte>
SECRETS_KEY=<chave-aleatoria-forte>
```

Use o hostname `postgres` e a porta `5432` na URL do banco dentro da rede do Compose. Configure `APP_URL` e `CORS_ORIGIN` com o domínio público atendido pelo proxy reverso e TLS. Não defina `WEB_DIST_DIR` como vazio: deixe o padrão da imagem, a menos que tenha configurado explicitamente outro diretório válido. Configure também credenciais RD ou SMTP quando os recursos correspondentes forem usados.

Antes de iniciar ou atualizar schema, faça e verifique um backup PostgreSQL. Mantenha backups em armazenamento persistente fora dos containers e volumes da aplicação.

## Build e inicialização

O Compose de produção compila a imagem a partir do checkout local. Ajuste opcionalmente `RD_IMAGE` e `TAG` no ambiente para nomear a imagem.

```bash
docker compose -f docker-compose.prod.yml build
docker compose -f docker-compose.prod.yml up -d
docker compose -f docker-compose.prod.yml logs -f api
```

A inicialização da API aplica as migrações configuradas antes de servir requisições. Faça backup antes de cada atualização de schema e verifique os logs e o endpoint de saúde após a inicialização.

## Backup e recuperação

Use `scripts/backup-postgres.sh` para gerar um dump PostgreSQL em armazenamento persistente configurado no host. Restrinja o acesso aos arquivos e configure retenção segundo os requisitos locais. Teste a restauração em um banco isolado antes de depender do backup. Nunca use o banco ativo como destino de um teste de restauração.

O repositório inclui templates de systemd para agendamento opcional. Revise caminhos, permissões, ambiente e política de retenção para o seu host antes de instalá-los.
