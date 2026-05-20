DENETRAI - Vercel Sürümü
========================

Yerel açma:
- index.html dosyasına çift tıklayın (AI chat çalışmaz, sadece statik arayüz).

Vercel'e deploy:
1. Bu klasörü bir GitHub reposuna pushlayın.
2. vercel.com > New Project > repoyu içe aktarın.
3. Environment Variables bölümüne ekleyin:
     OPENAI_API_KEY   = sk-...
     (opsiyonel) OPENAI_MODEL = gpt-4o-mini
4. Deploy.

Notlar:
- API anahtarı yalnızca sunucu tarafında (api/chat.js) kullanılır, client'a sızmaz.
- /api/chat üzerinde IP başına dakikada 20 istek limiti vardır (kötüye kullanım koruması).
- Logo index.html içine gömülüdür; ayrı dosyaya ihtiyaç yoktur.
