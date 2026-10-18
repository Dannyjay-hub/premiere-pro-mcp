# MCP für Adobe Premiere Pro

**Languages:** [English](README.md) · [Español](README.es.md) · [Português (Brasil)](README.pt-BR.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Русский](README.ru.md) · [العربية](README.ar.md) · [हिन्दी](README.hi.md) · [Italiano](README.it.md) · [Türkçe](README.tr.md) · [Bahasa Indonesia](README.id.md)

> Dies ist eine lokalisierte Einstiegshilfe. Die englische [README.md](README.md) ist die maßgebliche Quelle für Versionen, Werkzeugzahlen, Kompatibilität und aktuelle Einschränkungen.

Lokaler, unabhängiger MCP-Server für überprüfbare Arbeitsabläufe in Adobe Premiere Pro mit Claude, Cursor, Codex und anderen MCP-kompatiblen Clients. Das Projekt ist kostenlos, MIT-lizenziert und wird auf npm ausschließlich als [`premiere-pro-mcp`](https://www.npmjs.com/package/premiere-pro-mcp) veröffentlicht.

Dieses Projekt ist weder mit Adobe Inc. verbunden noch von Adobe unterstützt.

## Wichtigste Funktionen

- Projekte, Sequenzen, Spuren, Clips, Marker und Metadaten prüfen.
- Strukturierte Bearbeitungen über das produktive CEP-Panel ausführen.
- Dokumentierte, fähigkeitsabhängige UXP-Werkzeuge ab Premiere 25.6 verwenden.
- Exporte vorbereiten, Dateien prüfen und nachvollziehbare Übergaben organisieren.
- Eindeutige Ergebnisse liefern: `verified`, `committed_unverified`, `not_applied` oder Fehler.

Ein aufgeführtes Werkzeug beweist nicht, dass eine bestimmte Premiere-Version es unterstützt. Automatisierte Tests prüfen das Paket, nicht eine echte Premiere-Sitzung.

## Schnellstart

Voraussetzungen: Node.js 20.19 oder neuer, Premiere Pro 2020–2026 und ein kompatibler MCP-Client.

```bash
npm install -g premiere-pro-mcp
premiere-pro-mcp --install-cep
```

Premiere Pro neu starten und den Client so konfigurieren:

```json
{
  "mcpServers": {
    "premiere-pro": {
      "command": "premiere-pro-mcp"
    }
  }
}
```

Mit `verify_premiere_connection` beginnen. Keine Änderungen vornehmen, bevor die Verbindung bestätigt ist. Für den ersten Test eine Projektkopie verwenden.

## Architektur und Sicherheit

Der lokale Node.js-Server kommuniziert über stdio mit dem MCP-Client. Das CEP-Panel verwendet privaten dateibasierten IPC. UXP ist ein authentifiziertes, fähigkeitsbewusstes Vorschau-Backend; eine fehlgeschlagene UXP-Änderung wird niemals unbemerkt über CEP oder QE DOM wiederholt.

Unsichere Skripte sind standardmäßig deaktiviert. Telemetrie ist optional und erfasst keine Prompts, Argumente, Ergebnisse, Tokens, Projektpfade oder Mediennamen.

## Weitere Informationen

[Installationsanleitung](https://premiere-pro-mcp.com/blog/how-to-set-up-premiere-pro-mcp/) · [Veröffentlichte Werkzeuge](https://premiere-pro-mcp.com/tools/) · [Fehlerbehebung](https://premiere-pro-mcp.com/docs/troubleshooting/) · [Versionsdaten](https://premiere-pro-mcp.com/facts/) · [Sicherheit](SECURITY.md) · [Mitwirken](CONTRIBUTING.md)

## Lizenz

[MIT](LICENSE)

