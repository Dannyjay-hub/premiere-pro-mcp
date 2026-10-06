# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| latest  | :white_check_mark: |

## Reporting a Vulnerability

If you discover a security vulnerability in this project, **please do not open a public GitHub issue**.

Instead, report it by opening a [GitHub Security Advisory](https://github.com/leancoderkavy/premiere-pro-mcp/security/advisories/new) (or contact the maintainer directly via GitHub).

Please include:

- A description of the vulnerability and its potential impact
- Steps to reproduce or a proof-of-concept
- Any suggested mitigations, if known

You can expect an acknowledgement within **48 hours** and a resolution timeline within **7 days** for critical issues.

## Security Considerations

This MCP server executes ExtendScript inside Adobe Premiere Pro via a CEP plugin. Please note:

- Default capabilities are `inspect,edit,export,filesystem`. Arbitrary scripting tools require an explicit `unsafe-script` capability; script-pattern validation is defense in depth, not a sandbox.
- Connect only trusted MCP clients. Authorized tools can read project/media content and change or export projects under the Adobe user's account.
- CEP IPC directories require verified private ownership, permissions and safe ancestry. UXP uses an authenticated loopback connection and runtime capability checks.
- Disk-backed project context can retain project names, transcripts, notes and metadata. Context directories and files are validated as private; unsafe existing storage is rejected. Use `PREMIERE_CONTEXT_BACKEND=memory` when persistence is unwanted.
- Metadata inspection defaults to bounded parsed fields with sensitive GPS, serial, author and contact data omitted. Raw packets require explicit sensitive-data opt-in; full media paths require separate opt-in.
- HTTP transport requires authentication and is intended for an operator-managed Premiere host. It is not a public multi-tenant editing service.
- Telemetry is opt-in operational metadata only. Treat local host errors and diagnostic logs as private; do not publish logs, project/media files, credentials or context databases in vulnerability reports.
- Package tests do not establish live Adobe host compatibility or production deployment security.
