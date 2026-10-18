# MCP untuk Adobe Premiere Pro

**Languages:** [English](README.md) · [Español](README.es.md) · [Português (Brasil)](README.pt-BR.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Русский](README.ru.md) · [العربية](README.ar.md) · [हिन्दी](README.hi.md) · [Italiano](README.it.md) · [Türkçe](README.tr.md) · [Bahasa Indonesia](README.id.md)

> Ini adalah panduan awal yang dilokalkan. [README.md](README.md) berbahasa Inggris tetap menjadi sumber kanonis untuk versi, jumlah alat, kompatibilitas, dan batasan terkini.

Server MCP lokal dan independen untuk alur kerja Adobe Premiere Pro yang dapat ditinjau dengan Claude, Cursor, Codex, dan klien lain yang kompatibel dengan MCP. Proyek ini gratis, berlisensi MIT, dan diterbitkan di npm hanya sebagai [`premiere-pro-mcp`](https://www.npmjs.com/package/premiere-pro-mcp).

Proyek ini tidak berafiliasi dengan atau didukung oleh Adobe Inc.

## Fitur utama

- Memeriksa proyek, sequence, track, klip, marker, dan metadata.
- Menjalankan pengeditan terstruktur melalui panel CEP produksi.
- Menggunakan alat UXP terdokumentasi yang memeriksa kemampuan host pada Premiere 25.6 atau yang lebih baru.
- Menyiapkan ekspor, memeriksa berkas, dan mengatur penyerahan yang dapat ditinjau.
- Mengembalikan hasil yang jelas: `verified`, `committed_unverified`, `not_applied`, atau gagal.

Alat yang tercantum tidak membuktikan dukungan pada versi Premiere tertentu. Pengujian otomatis memvalidasi paket, bukan sesi Premiere nyata.

## Mulai cepat

Persyaratan: Node.js 20.19 atau yang lebih baru, Premiere Pro 2020–2026, dan klien MCP yang kompatibel.

```bash
npm install -g premiere-pro-mcp
premiere-pro-mcp --install-cep
```

Mulai ulang Premiere Pro dan atur klien untuk menjalankan:

```json
{
  "mcpServers": {
    "premiere-pro": {
      "command": "premiere-pro-mcp"
    }
  }
}
```

Mulailah dengan `verify_premiere_connection`. Jangan membuat perubahan sebelum bridge terverifikasi. Gunakan salinan proyek untuk pengujian pertama.

## Arsitektur dan keamanan

Server Node.js lokal berkomunikasi dengan klien MCP melalui stdio. Panel CEP menggunakan IPC privat berbasis berkas. UXP adalah backend pratinjau terautentikasi yang mengenali kemampuan host; perubahan UXP yang gagal tidak pernah dicoba ulang secara diam-diam melalui CEP atau QE DOM.

Skrip tidak aman dinonaktifkan secara default. Telemetri bersifat pilihan dan tidak mengumpulkan prompt, argumen, hasil, token, jalur proyek, atau nama media.

## Informasi lanjutan

[Panduan penyiapan](https://premiere-pro-mcp.com/blog/how-to-set-up-premiere-pro-mcp/) · [Alat yang diterbitkan](https://premiere-pro-mcp.com/tools/) · [Pemecahan masalah](https://premiere-pro-mcp.com/docs/troubleshooting/) · [Fakta rilis](https://premiere-pro-mcp.com/facts/) · [Keamanan](SECURITY.md) · [Berkontribusi](CONTRIBUTING.md)

## Lisensi

[MIT](LICENSE)

