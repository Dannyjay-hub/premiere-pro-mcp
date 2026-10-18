# MCP para Adobe Premiere Pro

**Languages:** [English](README.md) · [Español](README.es.md) · [Português (Brasil)](README.pt-BR.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Русский](README.ru.md) · [العربية](README.ar.md) · [हिन्दी](README.hi.md) · [Italiano](README.it.md) · [Türkçe](README.tr.md) · [Bahasa Indonesia](README.id.md)

> Este é um guia inicial localizado. O [README.md](README.md) em inglês é a fonte canônica para versões, contagens de ferramentas, compatibilidade e limites atuais.

Servidor MCP local e independente para fluxos de trabalho revisáveis no Adobe Premiere Pro com Claude, Cursor, Codex e outros clientes compatíveis com MCP. É gratuito, licenciado sob MIT e publicado no npm somente como [`premiere-pro-mcp`](https://www.npmjs.com/package/premiere-pro-mcp).

Este projeto não é afiliado nem endossado pela Adobe Inc.

## Principais recursos

- Inspecionar projetos, sequências, faixas, clipes, marcadores e metadados.
- Executar edições estruturadas pelo painel CEP de produção.
- Usar ferramentas UXP documentadas e condicionadas a recursos no Premiere 25.6 ou posterior.
- Preparar exportações, verificar arquivos e organizar entregas revisáveis.
- Retornar resultados verificáveis: `verified`, `committed_unverified`, `not_applied` ou falha.

Uma ferramenta listada não prova suporte em uma versão específica do Premiere. Testes automatizados validam o pacote, não uma sessão real do Premiere.

## Início rápido

Requisitos: Node.js 20.19 ou posterior, Premiere Pro 2020–2026 e um cliente MCP compatível.

```bash
npm install -g premiere-pro-mcp
premiere-pro-mcp --install-cep
```

Reinicie o Premiere Pro e configure seu cliente para executar:

```json
{
  "mcpServers": {
    "premiere-pro": {
      "command": "premiere-pro-mcp"
    }
  }
}
```

Comece com `verify_premiere_connection`. Não faça alterações antes de confirmar que a ponte funciona. Use um projeto duplicado no primeiro teste.

## Arquitetura e segurança

O servidor Node.js local usa stdio para falar com o cliente MCP. O painel CEP usa IPC privado baseado em arquivos. UXP é um backend de prévia autenticado e consciente de recursos; uma mutação UXP com falha nunca é repetida silenciosamente via CEP ou QE DOM.

Scripts inseguros ficam desativados por padrão. A telemetria é opcional e não coleta prompts, argumentos, resultados, tokens, caminhos de projetos nem nomes de mídia.

## Saiba mais

[Guia de instalação](https://premiere-pro-mcp.com/blog/how-to-set-up-premiere-pro-mcp/) · [Ferramentas publicadas](https://premiere-pro-mcp.com/tools/) · [Solução de problemas](https://premiere-pro-mcp.com/docs/troubleshooting/) · [Fatos da versão](https://premiere-pro-mcp.com/facts/) · [Segurança](SECURITY.md) · [Contribuir](CONTRIBUTING.md)

## Licença

[MIT](LICENSE)

