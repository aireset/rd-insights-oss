# Processo de desenvolvimento

1. Identifique o escopo e registre mudanças funcionais relevantes.
2. Trabalhe em uma branch isolada e mantenha alterações limitadas à tarefa.
3. Execute as verificações apropriadas: typecheck, lint, testes, build e inicialização da API.
4. Atualize a documentação quando mudar comportamento ou configuração.
5. Revise o diff e valide que nenhum segredo, dado pessoal ou configuração privada foi incluído.
6. Integre alterações segundo o fluxo de revisão do repositório que hospeda sua cópia.

Use migrations aditivas e faça backup antes de aplicar mudanças de schema em instalações com dados.
