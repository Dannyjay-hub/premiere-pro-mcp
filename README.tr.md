# Adobe Premiere Pro için MCP

**Languages:** [English](README.md) · [Español](README.es.md) · [Português (Brasil)](README.pt-BR.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Русский](README.ru.md) · [العربية](README.ar.md) · [हिन्दी](README.hi.md) · [Italiano](README.it.md) · [Türkçe](README.tr.md) · [Bahasa Indonesia](README.id.md)

> Bu, yerelleştirilmiş bir başlangıç kılavuzudur. Sürümler, araç sayıları, uyumluluk ve güncel sınırlar için İngilizce [README.md](README.md) kanonik kaynaktır.

Claude, Cursor, Codex ve diğer MCP uyumlu istemcilerle Adobe Premiere Pro’da incelenebilir iş akışları sağlayan bağımsız, yerel MCP sunucusu. Ücretsizdir, MIT lisanslıdır ve npm’de yalnızca [`premiere-pro-mcp`](https://www.npmjs.com/package/premiere-pro-mcp) adıyla yayımlanır.

Bu proje Adobe Inc. ile bağlantılı değildir ve Adobe tarafından onaylanmamıştır.

## Temel özellikler

- Projeleri, sekansları, parçaları, klipleri, işaretçileri ve meta verileri inceleme.
- Üretim CEP paneli üzerinden yapılandırılmış düzenlemeler yapma.
- Premiere 25.6 ve sonrasında ana bilgisayar yeteneklerini denetleyen belgelenmiş UXP araçlarını kullanma.
- Dışa aktarımları hazırlama, dosyaları doğrulama ve incelenebilir teslimleri düzenleme.
- Açık sonuçlar döndürme: `verified`, `committed_unverified`, `not_applied` veya hata.

Bir aracın listelenmesi, belirli bir Premiere sürümünde desteklendiğini kanıtlamaz. Otomatik testler paketi doğrular; gerçek bir Premiere oturumunu doğrulamaz.

## Hızlı başlangıç

Gereksinimler: Node.js 20.19 veya üzeri, Premiere Pro 2020–2026 ve uyumlu bir MCP istemcisi.

```bash
npm install -g premiere-pro-mcp
premiere-pro-mcp --install-cep
```

Premiere Pro’yu yeniden başlatın ve istemcinizi şunu çalıştıracak şekilde yapılandırın:

```json
{
  "mcpServers": {
    "premiere-pro": {
      "command": "premiere-pro-mcp"
    }
  }
}
```

Önce `verify_premiere_connection` çağrısını yapın. Köprü doğrulanmadan değişiklik yapmayın. İlk testte projenin bir kopyasını kullanın.

## Mimari ve güvenlik

Yerel Node.js sunucusu MCP istemcisiyle stdio üzerinden iletişim kurar. CEP paneli özel, dosya tabanlı IPC kullanır. UXP, kimliği doğrulanmış ve yetenekleri algılayan bir önizleme arka ucudur; başarısız bir UXP değişikliği CEP veya QE DOM üzerinden sessizce yeniden denenmez.

Güvenli olmayan komut dosyaları varsayılan olarak kapalıdır. Telemetri isteğe bağlıdır ve istemleri, bağımsız değişkenleri, sonuçları, belirteçleri, proje yollarını veya medya adlarını toplamaz.

## Daha fazla bilgi

[Kurulum kılavuzu](https://premiere-pro-mcp.com/blog/how-to-set-up-premiere-pro-mcp/) · [Yayımlanmış araçlar](https://premiere-pro-mcp.com/tools/) · [Sorun giderme](https://premiere-pro-mcp.com/docs/troubleshooting/) · [Sürüm gerçekleri](https://premiere-pro-mcp.com/facts/) · [Güvenlik](SECURITY.md) · [Katkıda bulunma](CONTRIBUTING.md)

## Lisans

[MIT](LICENSE)

