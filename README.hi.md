# Adobe Premiere Pro के लिए MCP

**Languages:** [English](README.md) · [Español](README.es.md) · [Português (Brasil)](README.pt-BR.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Русский](README.ru.md) · [العربية](README.ar.md) · [हिन्दी](README.hi.md) · [Italiano](README.it.md) · [Türkçe](README.tr.md) · [Bahasa Indonesia](README.id.md)

> यह स्थानीयकृत आरंभिक मार्गदर्शिका है। संस्करण, टूल संख्या, संगतता और मौजूदा सीमाओं के लिए अंग्रेज़ी [README.md](README.md) आधिकारिक स्रोत है।

Claude, Cursor, Codex और अन्य MCP-संगत क्लाइंट के साथ Adobe Premiere Pro में समीक्षा योग्य वर्कफ़्लो के लिए स्वतंत्र, स्थानीय MCP सर्वर। यह मुफ़्त है, MIT लाइसेंस के अंतर्गत है और npm पर केवल [`premiere-pro-mcp`](https://www.npmjs.com/package/premiere-pro-mcp) नाम से प्रकाशित है।

यह प्रोजेक्ट Adobe Inc. से संबद्ध या उसके द्वारा समर्थित नहीं है।

## मुख्य क्षमताएँ

- प्रोजेक्ट, सीक्वेंस, ट्रैक, क्लिप, मार्कर और मेटाडेटा की जाँच।
- प्रोडक्शन CEP पैनल से संरचित संपादन।
- Premiere 25.6 या नए संस्करण में होस्ट क्षमता जाँचने वाले दस्तावेज़ीकृत UXP टूल।
- एक्सपोर्ट तैयार करना, फ़ाइल जाँचना और समीक्षा योग्य डिलीवरी व्यवस्थित करना।
- स्पष्ट परिणाम लौटाना: `verified`, `committed_unverified`, `not_applied` या विफलता।

सूची में टूल होना किसी खास Premiere संस्करण में उसके समर्थन का प्रमाण नहीं है। स्वचालित परीक्षण पैकेज का व्यवहार जाँचते हैं, वास्तविक Premiere सत्र का नहीं।

## त्वरित शुरुआत

आवश्यकताएँ: Node.js 20.19 या नया, Premiere Pro 2020–2026 और संगत MCP क्लाइंट।

```bash
npm install -g premiere-pro-mcp
premiere-pro-mcp --install-cep
```

Premiere Pro को पुनः शुरू करें और क्लाइंट को यह चलाने के लिए कॉन्फ़िगर करें:

```json
{
  "mcpServers": {
    "premiere-pro": {
      "command": "premiere-pro-mcp"
    }
  }
}
```

पहले `verify_premiere_connection` चलाएँ। ब्रिज की पुष्टि से पहले कोई बदलाव न करें। पहले परीक्षण के लिए प्रोजेक्ट की कॉपी इस्तेमाल करें।

## संरचना और सुरक्षा

स्थानीय Node.js सर्वर stdio से MCP क्लाइंट से बात करता है। CEP पैनल निजी फ़ाइल-आधारित IPC का उपयोग करता है। UXP प्रमाणित और क्षमता-जागरूक पूर्वावलोकन बैकएंड है; विफल UXP बदलाव को CEP या QE DOM से चुपचाप दोबारा नहीं चलाया जाता।

असुरक्षित स्क्रिप्टिंग डिफ़ॉल्ट रूप से बंद है। टेलीमेट्री वैकल्पिक है और प्रॉम्प्ट, तर्क, परिणाम, टोकन, प्रोजेक्ट पथ या मीडिया नाम एकत्र नहीं करती।

## अधिक जानकारी

[सेटअप गाइड](https://premiere-pro-mcp.com/blog/how-to-set-up-premiere-pro-mcp/) · [प्रकाशित टूल](https://premiere-pro-mcp.com/tools/) · [समस्या निवारण](https://premiere-pro-mcp.com/docs/troubleshooting/) · [रिलीज़ तथ्य](https://premiere-pro-mcp.com/facts/) · [सुरक्षा](SECURITY.md) · [योगदान](CONTRIBUTING.md)

## लाइसेंस

[MIT](LICENSE)

