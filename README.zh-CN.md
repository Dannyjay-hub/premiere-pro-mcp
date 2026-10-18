# Adobe Premiere Pro MCP

**Languages:** [English](README.md) · [Español](README.es.md) · [Português (Brasil)](README.pt-BR.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Русский](README.ru.md) · [العربية](README.ar.md) · [हिन्दी](README.hi.md) · [Italiano](README.it.md) · [Türkçe](README.tr.md) · [Bahasa Indonesia](README.id.md)

> 这是本地化入门指南。英文 [README.md](README.md) 是版本、工具数量、兼容性和当前限制的唯一权威来源。

这是一个独立、本地运行的 MCP 服务器，可让 Claude、Cursor、Codex 及其他兼容 MCP 的客户端以可审查的方式操作 Adobe Premiere Pro。项目免费、采用 MIT 许可证，并且在 npm 上仅以 [`premiere-pro-mcp`](https://www.npmjs.com/package/premiere-pro-mcp) 名称发布。

本项目与 Adobe Inc. 无隶属关系，也未获得其认可。

## 主要功能

- 检查项目、序列、轨道、剪辑、标记和元数据。
- 通过生产环境 CEP 面板执行结构化编辑。
- 在 Premiere 25.6 及更高版本中使用有能力检测的文档化 UXP 工具。
- 准备导出、检查文件，并组织可审查的交付流程。
- 返回明确结果：`verified`、`committed_unverified`、`not_applied` 或失败。

工具出现在列表中，并不代表某个特定 Premiere 版本一定支持它。自动化测试只验证软件包行为，不证明真实 Premiere 主机行为。

## 快速开始

要求：Node.js 20.19 或更高版本、Premiere Pro 2020–2026，以及兼容的 MCP 客户端。

```bash
npm install -g premiere-pro-mcp
premiere-pro-mcp --install-cep
```

重启 Premiere Pro，然后让客户端运行：

```json
{
  "mcpServers": {
    "premiere-pro": {
      "command": "premiere-pro-mcp"
    }
  }
}
```

首先调用 `verify_premiere_connection`。确认桥接正常之前不要修改项目。首次测试请使用项目副本。

## 架构与安全

本地 Node.js 服务器通过 stdio 与 MCP 客户端通信。CEP 面板使用私有的文件 IPC。UXP 是经过身份验证、能够检测宿主能力的预览后端；UXP 修改失败后，绝不会静默改用 CEP 或 QE DOM 重试。

不安全脚本默认关闭。遥测为自愿启用，且不会收集提示词、参数、结果、令牌、项目路径或媒体名称。

## 更多信息

[安装指南](https://premiere-pro-mcp.com/blog/how-to-set-up-premiere-pro-mcp/) · [已发布工具](https://premiere-pro-mcp.com/tools/) · [故障排除](https://premiere-pro-mcp.com/docs/troubleshooting/) · [版本事实](https://premiere-pro-mcp.com/facts/) · [安全](SECURITY.md) · [贡献](CONTRIBUTING.md)

## 许可证

[MIT](LICENSE)

