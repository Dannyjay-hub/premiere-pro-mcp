# MCP لبرنامج Adobe Premiere Pro

**Languages:** [English](README.md) · [Español](README.es.md) · [Português (Brasil)](README.pt-BR.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Русский](README.ru.md) · [العربية](README.ar.md) · [हिन्दी](README.hi.md) · [Italiano](README.it.md) · [Türkçe](README.tr.md) · [Bahasa Indonesia](README.id.md)

> هذا دليل بدء مترجم. يظل ملف [README.md](README.md) الإنجليزي المصدر المعتمد للإصدارات وعدد الأدوات والتوافق والقيود الحالية.

خادم MCP محلي ومستقل لسير عمل قابل للمراجعة في Adobe Premiere Pro مع Claude وCursor وCodex والعملاء الآخرين المتوافقين مع MCP. المشروع مجاني ومرخّص بموجب MIT ومنشور على npm باسم [`premiere-pro-mcp`](https://www.npmjs.com/package/premiere-pro-mcp) فقط.

هذا المشروع غير تابع لشركة Adobe Inc. وغير معتمد منها.

## الميزات الرئيسية

- فحص المشاريع والتسلسلات والمسارات والمقاطع والعلامات والبيانات الوصفية.
- تنفيذ تعديلات منظّمة من خلال لوحة CEP الأساسية.
- استخدام أدوات UXP الموثقة والمقيّدة بقدرات المضيف في Premiere 25.6 أو أحدث.
- إعداد عمليات التصدير وفحص الملفات وتنظيم تسليمات قابلة للمراجعة.
- إرجاع نتائج واضحة: `verified` أو `committed_unverified` أو `not_applied` أو فشل.

وجود أداة في القائمة لا يثبت دعم إصدار محدد من Premiere لها. الاختبارات الآلية تتحقق من سلوك الحزمة، وليس من جلسة Premiere حقيقية.

## البدء السريع

المتطلبات: Node.js 20.19 أو أحدث، وPremiere Pro 2020–2026، وعميل MCP متوافق.

```bash
npm install -g premiere-pro-mcp
premiere-pro-mcp --install-cep
```

أعد تشغيل Premiere Pro واضبط العميل لتشغيل:

```json
{
  "mcpServers": {
    "premiere-pro": {
      "command": "premiere-pro-mcp"
    }
  }
}
```

ابدأ باستدعاء `verify_premiere_connection`. لا تُجرِ أي تعديل قبل التأكد من عمل الجسر. استخدم نسخة من المشروع في الاختبار الأول.

## البنية والأمان

يتواصل خادم Node.js المحلي مع عميل MCP عبر stdio. تستخدم لوحة CEP اتصال IPC خاصاً قائماً على الملفات. UXP هو خلفية معاينة موثقة وواعية بقدرات المضيف؛ عند فشل تعديل UXP، لا تتم إعادة المحاولة بصمت عبر CEP أو QE DOM.

تكون البرمجة النصية غير الآمنة معطلة افتراضياً. القياس عن بُعد اختياري ولا يجمع المطالبات أو الوسائط أو النتائج أو الرموز أو مسارات المشاريع أو أسماء ملفات الوسائط.

## مزيد من المعلومات

[دليل التثبيت](https://premiere-pro-mcp.com/blog/how-to-set-up-premiere-pro-mcp/) · [الأدوات المنشورة](https://premiere-pro-mcp.com/tools/) · [حل المشكلات](https://premiere-pro-mcp.com/docs/troubleshooting/) · [حقائق الإصدار](https://premiere-pro-mcp.com/facts/) · [الأمان](SECURITY.md) · [المساهمة](CONTRIBUTING.md)

## الترخيص

[MIT](LICENSE)

