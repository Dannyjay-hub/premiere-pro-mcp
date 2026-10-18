# MCP pour Adobe Premiere Pro

**Languages:** [English](README.md) · [Español](README.es.md) · [Português (Brasil)](README.pt-BR.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Русский](README.ru.md) · [العربية](README.ar.md) · [हिन्दी](README.hi.md) · [Italiano](README.it.md) · [Türkçe](README.tr.md) · [Bahasa Indonesia](README.id.md)

> Ceci est un guide de démarrage localisé. Le [README.md](README.md) anglais reste la source canonique pour les versions, le nombre d’outils, la compatibilité et les limites actuelles.

Serveur MCP local et indépendant pour des flux de travail vérifiables dans Adobe Premiere Pro avec Claude, Cursor, Codex et d’autres clients compatibles MCP. Il est gratuit, sous licence MIT et publié sur npm uniquement sous le nom [`premiere-pro-mcp`](https://www.npmjs.com/package/premiere-pro-mcp).

Ce projet n’est ni affilié à Adobe Inc. ni approuvé par celle-ci.

## Fonctions principales

- Inspecter projets, séquences, pistes, plans, marqueurs et métadonnées.
- Effectuer des montages structurés via le panneau CEP de production.
- Utiliser des outils UXP documentés et limités par les capacités de Premiere 25.6 ou version ultérieure.
- Préparer les exports, vérifier les fichiers et organiser des livraisons contrôlables.
- Retourner des états explicites : `verified`, `committed_unverified`, `not_applied` ou échec.

La présence d’un outil ne prouve pas sa prise en charge par une version donnée de Premiere. Les tests automatisés valident le paquet, pas une session Premiere réelle.

## Démarrage rapide

Prérequis : Node.js 20.19 ou version ultérieure, Premiere Pro 2020–2026 et un client MCP compatible.

```bash
npm install -g premiere-pro-mcp
premiere-pro-mcp --install-cep
```

Redémarrez Premiere Pro puis configurez votre client pour exécuter :

```json
{
  "mcpServers": {
    "premiere-pro": {
      "command": "premiere-pro-mcp"
    }
  }
}
```

Commencez par `verify_premiere_connection`. Ne modifiez rien avant d’avoir confirmé que le pont fonctionne. Utilisez une copie du projet pour le premier essai.

## Architecture et sécurité

Le serveur Node.js local communique avec le client MCP via stdio. Le panneau CEP utilise un IPC privé fondé sur des fichiers. UXP est un backend d’aperçu authentifié et conscient des capacités ; une mutation UXP échouée n’est jamais retentée silencieusement via CEP ou QE DOM.

Les scripts non sécurisés sont désactivés par défaut. La télémétrie est facultative et ne collecte ni prompts, ni arguments, ni résultats, ni jetons, ni chemins de projet, ni noms de médias.

## En savoir plus

[Guide d’installation](https://premiere-pro-mcp.com/blog/how-to-set-up-premiere-pro-mcp/) · [Outils publiés](https://premiere-pro-mcp.com/tools/) · [Dépannage](https://premiere-pro-mcp.com/docs/troubleshooting/) · [Données de version](https://premiere-pro-mcp.com/facts/) · [Sécurité](SECURITY.md) · [Contribuer](CONTRIBUTING.md)

## Licence

[MIT](LICENSE)

