# MCP для Adobe Premiere Pro

**Languages:** [English](README.md) · [Español](README.es.md) · [Português (Brasil)](README.pt-BR.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Русский](README.ru.md) · [العربية](README.ar.md) · [हिन्दी](README.hi.md) · [Italiano](README.it.md) · [Türkçe](README.tr.md) · [Bahasa Indonesia](README.id.md)

> Это локализованное краткое руководство. Английский [README.md](README.md) остаётся каноническим источником данных о версиях, количестве инструментов, совместимости и текущих ограничениях.

Независимый локальный MCP-сервер для проверяемых рабочих процессов Adobe Premiere Pro с Claude, Cursor, Codex и другими MCP-совместимыми клиентами. Проект бесплатный, распространяется по лицензии MIT и публикуется в npm только как [`premiere-pro-mcp`](https://www.npmjs.com/package/premiere-pro-mcp).

Проект не связан с Adobe Inc. и не одобрен ею.

## Основные возможности

- Просмотр проектов, секвенций, дорожек, клипов, маркеров и метаданных.
- Структурированный монтаж через основной CEP-панель.
- Документированные UXP-инструменты с проверкой возможностей хоста в Premiere 25.6 и новее.
- Подготовка экспорта, проверка файлов и организация контролируемой передачи.
- Явные результаты: `verified`, `committed_unverified`, `not_applied` или ошибка.

Наличие инструмента в каталоге не доказывает поддержку конкретной версией Premiere. Автоматические тесты проверяют пакет, а не реальный сеанс Premiere.

## Быстрый старт

Требования: Node.js 20.19 или новее, Premiere Pro 2020–2026 и совместимый MCP-клиент.

```bash
npm install -g premiere-pro-mcp
premiere-pro-mcp --install-cep
```

Перезапустите Premiere Pro и настройте клиент на запуск:

```json
{
  "mcpServers": {
    "premiere-pro": {
      "command": "premiere-pro-mcp"
    }
  }
}
```

Сначала вызовите `verify_premiere_connection`. Не вносите изменения, пока соединение не подтверждено. Для первой проверки используйте копию проекта.

## Архитектура и безопасность

Локальный сервер Node.js общается с MCP-клиентом через stdio. CEP-панель использует закрытый файловый IPC. UXP — аутентифицированный предварительный backend с проверкой возможностей; после ошибки UXP изменение никогда не повторяется скрытно через CEP или QE DOM.

Небезопасные сценарии отключены по умолчанию. Телеметрия включается добровольно и не собирает промпты, аргументы, результаты, токены, пути проектов или имена медиафайлов.

## Подробнее

[Установка](https://premiere-pro-mcp.com/blog/how-to-set-up-premiere-pro-mcp/) · [Опубликованные инструменты](https://premiere-pro-mcp.com/tools/) · [Решение проблем](https://premiere-pro-mcp.com/docs/troubleshooting/) · [Данные релиза](https://premiere-pro-mcp.com/facts/) · [Безопасность](SECURITY.md) · [Участие](CONTRIBUTING.md)

## Лицензия

[MIT](LICENSE)

