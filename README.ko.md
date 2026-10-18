# Adobe Premiere Pro MCP

**Languages:** [English](README.md) · [Español](README.es.md) · [Português (Brasil)](README.pt-BR.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Русский](README.ru.md) · [العربية](README.ar.md) · [हिन्दी](README.hi.md) · [Italiano](README.it.md) · [Türkçe](README.tr.md) · [Bahasa Indonesia](README.id.md)

> 이 문서는 현지화된 시작 안내서입니다. 버전, 도구 수, 호환성, 현재 제한에 대한 공식 기준은 영어 [README.md](README.md)입니다.

Claude, Cursor, Codex 등 MCP 호환 클라이언트에서 Adobe Premiere Pro의 검토 가능한 워크플로를 실행하기 위한 독립형 로컬 MCP 서버입니다. 무료 MIT 라이선스로 제공되며 npm에는 [`premiere-pro-mcp`](https://www.npmjs.com/package/premiere-pro-mcp)라는 이름으로만 게시됩니다.

이 프로젝트는 Adobe Inc.와 제휴하거나 Adobe의 승인을 받은 프로젝트가 아닙니다.

## 주요 기능

- 프로젝트, 시퀀스, 트랙, 클립, 마커, 메타데이터 검사.
- 프로덕션 CEP 패널을 통한 구조화된 편집 실행.
- Premiere 25.6 이상에서 호스트 기능을 확인하는 문서화된 UXP 도구 사용.
- 내보내기 준비, 파일 검사, 검토 가능한 전달 작업 구성.
- `verified`, `committed_unverified`, `not_applied` 또는 실패 상태를 명확히 반환.

도구가 목록에 있다고 해서 특정 Premiere 버전에서 지원된다는 의미는 아닙니다. 자동화 테스트는 패키지 동작을 검증할 뿐 실제 Premiere 호스트 동작을 증명하지 않습니다.

## 빠른 시작

요구 사항: Node.js 20.19 이상, Premiere Pro 2020–2026, MCP 호환 클라이언트.

```bash
npm install -g premiere-pro-mcp
premiere-pro-mcp --install-cep
```

Premiere Pro를 다시 시작하고 클라이언트를 다음과 같이 설정합니다.

```json
{
  "mcpServers": {
    "premiere-pro": {
      "command": "premiere-pro-mcp"
    }
  }
}
```

먼저 `verify_premiere_connection`을 실행하세요. 브리지가 정상임을 확인하기 전에는 변경하지 마세요. 첫 테스트에는 프로젝트 복사본을 사용하세요.

## 아키텍처와 보안

로컬 Node.js 서버는 stdio로 MCP 클라이언트와 통신합니다. CEP 패널은 비공개 파일 기반 IPC를 사용합니다. UXP는 인증되고 기능을 인식하는 미리 보기 백엔드입니다. UXP 변경이 실패해도 CEP 또는 QE DOM으로 자동 재시도하지 않습니다.

안전하지 않은 스크립트는 기본적으로 비활성화됩니다. 원격 측정은 선택 사항이며 프롬프트, 인수, 결과, 토큰, 프로젝트 경로 또는 미디어 이름을 수집하지 않습니다.

## 자세히 알아보기

[설치 안내](https://premiere-pro-mcp.com/blog/how-to-set-up-premiere-pro-mcp/) · [공개 도구](https://premiere-pro-mcp.com/tools/) · [문제 해결](https://premiere-pro-mcp.com/docs/troubleshooting/) · [릴리스 정보](https://premiere-pro-mcp.com/facts/) · [보안](SECURITY.md) · [기여](CONTRIBUTING.md)

## 라이선스

[MIT](LICENSE)

