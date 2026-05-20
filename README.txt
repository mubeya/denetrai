DENETRAI - Netlify Sürümü
=========================

Yerel açma:
- index.html dosyasına çift tıklayın (AI chat yerelde çalışmaz, fallback devreye girer).

Netlify'a deploy:
1. Bu klasör GitHub reposuna pushlanmış olmalı (mubeya/denetrai).
2. app.netlify.com > Add new site > Import an existing project > GitHub > denetrai reposunu seç.
3. Build settings (otomatik algılanır, dokunma):
     Build command   : (boş)
     Publish directory: .
     Functions       : netlify/functions
4. Site settings > Environment variables ekle:
     OPENAI_API_KEY = sk-...
     (opsiyonel) OPENAI_MODEL = gpt-4o-mini
5. Deploy.

Notlar:
- API anahtarı yalnızca sunucu tarafında (netlify/functions/chat.mjs) kullanılır.
- /api/chat istekleri netlify.toml içindeki redirect ile /.netlify/functions/chat'e gider.
- Function üzerinde IP başına dakikada 20 istek limiti vardır.
