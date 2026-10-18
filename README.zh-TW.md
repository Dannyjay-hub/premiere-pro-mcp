# Adobe Premiere Pro MCP

**Languages:** [English](README.md) · [Español](README.es.md) · [Português (Brasil)](README.pt-BR.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Русский](README.ru.md) · [العربية](README.ar.md) · [हिन्दी](README.hi.md) · [Italiano](README.it.md) · [Türkçe](README.tr.md) · [Bahasa Indonesia](README.id.md)

> 這是本地化入門指南。英文 [README.md](README.md) 是版本、工具數量、相容性與目前限制的唯一權威來源。

這是一個獨立、本機執行的 MCP 伺服器，讓 Claude、Cursor、Codex 與其他相容 MCP 的用戶端能以可審查方式操作 Adobe Premiere Pro。專案免費、採用 MIT 授權，並且在 npm 上僅以 [`premiere-pro-mcp`](https://www.npmjs.com/package/premiere-pro-mcp) 名稱發布。

本專案與 Adobe Inc. 無隸屬關係，也未獲其背書。

## 主要功能

- 檢查專案、序列、軌道、剪輯、標記與中繼資料。
- 透過正式 CEP 面板執行結構化編輯。
- 在 Premiere 25.6 以上版本使用具能力偵測的文件化 UXP 工具。
- 準備匯出、檢查檔案，並組織可審查的交付流程。
- 回傳明確結果：`verified`、`committed_unverified`、`not_applied` 或失敗。

工具列在目錄中，不代表特定 Premiere 版本一定支援。自動化測試只驗證套件行為，不證明真實 Premiere 主機行為。

## 快速開始

需求：Node.js 20.19 以上、Premiere Pro 2020–2026，以及相容的 MCP 用戶端。

```bash
npm install -g premiere-pro-mcp
premiere-pro-mcp --install-cep
```

重新啟動 Premiere Pro，並設定用戶端執行：

```json
{
  "mcpServers": {
    "premiere-pro": {
      "command": "premiere-pro-mcp"
    }
  }
}
```

先呼叫 `verify_premiere_connection`。確認橋接正常前不要修改專案。第一次測試請使用專案副本。

## 架構與安全

本機 Node.js 伺服器透過 stdio 與 MCP 用戶端通訊。CEP 面板使用私有的檔案式 IPC。UXP 是經過驗證且能辨識宿主能力的預覽後端；UXP 修改失敗後，絕不會靜默改用 CEP 或 QE DOM 重試。

不安全指令碼預設停用。遙測需主動選用，且不會收集提示詞、參數、結果、權杖、專案路徑或媒體名稱。

## 更多資訊

[安裝指南](https://premiere-pro-mcp.com/blog/how-to-set-up-premiere-pro-mcp/) · [已發布工具](https://premiere-pro-mcp.com/tools/) · [疑難排解](https://premiere-pro-mcp.com/docs/troubleshooting/) · [版本事實](https://premiere-pro-mcp.com/facts/) · [安全](SECURITY.md) · [貢獻](CONTRIBUTING.md)

## 授權

[MIT](LICENSE)

