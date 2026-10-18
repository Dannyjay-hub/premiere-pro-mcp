# MCP per Adobe Premiere Pro

**Languages:** [English](README.md) · [Español](README.es.md) · [Português (Brasil)](README.pt-BR.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Русский](README.ru.md) · [العربية](README.ar.md) · [हिन्दी](README.hi.md) · [Italiano](README.it.md) · [Türkçe](README.tr.md) · [Bahasa Indonesia](README.id.md)

> Questa è una guida introduttiva localizzata. Il [README.md](README.md) inglese rimane la fonte canonica per versioni, numero di strumenti, compatibilità e limiti correnti.

Server MCP locale e indipendente per flussi di lavoro verificabili in Adobe Premiere Pro con Claude, Cursor, Codex e altri client compatibili con MCP. È gratuito, distribuito con licenza MIT e pubblicato su npm esclusivamente come [`premiere-pro-mcp`](https://www.npmjs.com/package/premiere-pro-mcp).

Questo progetto non è affiliato né approvato da Adobe Inc.

## Funzioni principali

- Ispezionare progetti, sequenze, tracce, clip, marcatori e metadati.
- Eseguire modifiche strutturate tramite il pannello CEP di produzione.
- Usare strumenti UXP documentati e vincolati alle capacità dell’host in Premiere 25.6 o versioni successive.
- Preparare esportazioni, verificare file e organizzare consegne revisionabili.
- Restituire risultati espliciti: `verified`, `committed_unverified`, `not_applied` o errore.

La presenza di uno strumento nell’elenco non prova il supporto in una specifica versione di Premiere. I test automatici verificano il pacchetto, non una sessione Premiere reale.

## Avvio rapido

Requisiti: Node.js 20.19 o successivo, Premiere Pro 2020–2026 e un client MCP compatibile.

```bash
npm install -g premiere-pro-mcp
premiere-pro-mcp --install-cep
```

Riavvia Premiere Pro e configura il client per eseguire:

```json
{
  "mcpServers": {
    "premiere-pro": {
      "command": "premiere-pro-mcp"
    }
  }
}
```

Inizia con `verify_premiere_connection`. Non apportare modifiche prima di aver verificato il bridge. Per il primo test usa una copia del progetto.

## Architettura e sicurezza

Il server Node.js locale comunica con il client MCP tramite stdio. Il pannello CEP usa IPC privato basato su file. UXP è un backend di anteprima autenticato e consapevole delle capacità; una modifica UXP fallita non viene mai ritentata silenziosamente tramite CEP o QE DOM.

Gli script non sicuri sono disabilitati per impostazione predefinita. La telemetria è facoltativa e non raccoglie prompt, argomenti, risultati, token, percorsi dei progetti o nomi dei file multimediali.

## Ulteriori informazioni

[Guida all’installazione](https://premiere-pro-mcp.com/blog/how-to-set-up-premiere-pro-mcp/) · [Strumenti pubblicati](https://premiere-pro-mcp.com/tools/) · [Risoluzione dei problemi](https://premiere-pro-mcp.com/docs/troubleshooting/) · [Dati di rilascio](https://premiere-pro-mcp.com/facts/) · [Sicurezza](SECURITY.md) · [Contribuire](CONTRIBUTING.md)

## Licenza

[MIT](LICENSE)

