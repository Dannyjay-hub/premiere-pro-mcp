# MCP para Adobe Premiere Pro

**Languages:** [English](README.md) · [Español](README.es.md) · [Português (Brasil)](README.pt-BR.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Русский](README.ru.md) · [العربية](README.ar.md) · [हिन्दी](README.hi.md) · [Italiano](README.it.md) · [Türkçe](README.tr.md) · [Bahasa Indonesia](README.id.md)

> Esta es una guía de inicio localizada. [README.md](README.md) en inglés es la fuente canónica para versiones, recuentos de herramientas, compatibilidad y límites actuales.

Servidor MCP local e independiente para flujos de trabajo revisables en Adobe Premiere Pro con Claude, Cursor, Codex y otros clientes compatibles con MCP. Es gratuito, tiene licencia MIT y se publica en npm únicamente como [`premiere-pro-mcp`](https://www.npmjs.com/package/premiere-pro-mcp).

Este proyecto no está afiliado ni respaldado por Adobe Inc.

## Funciones principales

- Inspeccionar proyectos, secuencias, pistas, clips, marcadores y metadatos.
- Ejecutar ediciones estructuradas mediante el panel CEP de producción.
- Usar herramientas UXP documentadas y condicionadas por capacidades en Premiere 25.6 o posterior.
- Preparar exportaciones, comprobar archivos y organizar entregas revisables.
- Devolver resultados verificables: `verified`, `committed_unverified`, `not_applied` o error.

Una herramienta registrada no demuestra que una versión concreta de Premiere la admita. Las pruebas automatizadas validan el paquete, no una sesión real de Premiere.

## Inicio rápido

Requisitos: Node.js 20.19 o posterior, Premiere Pro 2020–2026 y un cliente MCP compatible.

```bash
npm install -g premiere-pro-mcp
premiere-pro-mcp --install-cep
```

Reinicia Premiere Pro y configura tu cliente para ejecutar:

```json
{
  "mcpServers": {
    "premiere-pro": {
      "command": "premiere-pro-mcp"
    }
  }
}
```

Empieza con `verify_premiere_connection`. No realices cambios hasta confirmar que el puente funciona. Usa un proyecto duplicado para la primera prueba.

## Arquitectura y seguridad

El servidor Node.js local usa stdio para comunicarse con el cliente MCP. El panel CEP se comunica mediante IPC privado basado en archivos. UXP es un backend de vista previa autenticado y consciente de capacidades; una mutación UXP fallida nunca se reintenta silenciosamente mediante CEP o QE DOM.

Los scripts inseguros están desactivados de forma predeterminada. La telemetría es opcional y no recopila prompts, argumentos, resultados, tokens, rutas de proyectos ni nombres de archivos multimedia.

## Más información

[Guía de instalación](https://premiere-pro-mcp.com/blog/how-to-set-up-premiere-pro-mcp/) · [Herramientas publicadas](https://premiere-pro-mcp.com/tools/) · [Solución de problemas](https://premiere-pro-mcp.com/docs/troubleshooting/) · [Hechos de la versión](https://premiere-pro-mcp.com/facts/) · [Seguridad](SECURITY.md) · [Contribuir](CONTRIBUTING.md)

## Licencia

[MIT](LICENSE)

