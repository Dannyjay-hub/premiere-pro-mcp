# Adobe Premiere Pro MCP

**Languages:** [English](README.md) · [Español](README.es.md) · [Português (Brasil)](README.pt-BR.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Русский](README.ru.md) · [العربية](README.ar.md) · [हिन्दी](README.hi.md) · [Italiano](README.it.md) · [Türkçe](README.tr.md) · [Bahasa Indonesia](README.id.md)

> これはローカライズされた入門ガイドです。バージョン、ツール数、互換性、現在の制約については、英語版 [README.md](README.md) が唯一の正規情報です。

Claude、Cursor、Codex などの MCP 対応クライアントから Adobe Premiere Pro の確認可能なワークフローを利用するための、独立したローカル MCP サーバーです。無料の MIT ライセンスで、npm では [`premiere-pro-mcp`](https://www.npmjs.com/package/premiere-pro-mcp) という名前だけで公開されています。

本プロジェクトは Adobe Inc. と提携しておらず、同社の承認も受けていません。

## 主な機能

- プロジェクト、シーケンス、トラック、クリップ、マーカー、メタデータを検査。
- 本番 CEP パネルを通じて構造化された編集を実行。
- Premiere 25.6 以降で、ホスト能力を確認する文書化済み UXP ツールを使用。
- 書き出しの準備、ファイル検査、レビュー可能な納品作業を支援。
- `verified`、`committed_unverified`、`not_applied`、失敗のいずれかを明示。

ツール一覧への掲載は、特定の Premiere バージョンでの対応を証明しません。自動テストはパッケージの動作を検証するもので、実際の Premiere ホストを検証するものではありません。

## クイックスタート

必要条件：Node.js 20.19 以降、Premiere Pro 2020–2026、MCP 対応クライアント。

```bash
npm install -g premiere-pro-mcp
premiere-pro-mcp --install-cep
```

Premiere Pro を再起動し、クライアントを次のように設定します。

```json
{
  "mcpServers": {
    "premiere-pro": {
      "command": "premiere-pro-mcp"
    }
  }
}
```

最初に `verify_premiere_connection` を実行してください。ブリッジを確認するまで変更を加えないでください。初回テストにはプロジェクトの複製を使用してください。

## アーキテクチャと安全性

ローカル Node.js サーバーは stdio で MCP クライアントと通信します。CEP パネルは非公開のファイル IPC を使用します。UXP は認証済みで能力を認識するプレビュー用バックエンドです。UXP の変更が失敗しても、CEP や QE DOM へ暗黙にフォールバックしません。

安全でないスクリプト機能は既定で無効です。テレメトリはオプトインであり、プロンプト、引数、結果、トークン、プロジェクトパス、メディア名を収集しません。

## 関連情報

[セットアップ](https://premiere-pro-mcp.com/blog/how-to-set-up-premiere-pro-mcp/) · [公開ツール](https://premiere-pro-mcp.com/tools/) · [トラブルシューティング](https://premiere-pro-mcp.com/docs/troubleshooting/) · [リリース情報](https://premiere-pro-mcp.com/facts/) · [セキュリティ](SECURITY.md) · [コントリビューション](CONTRIBUTING.md)

## ライセンス

[MIT](LICENSE)

