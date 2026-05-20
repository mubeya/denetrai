DENETRAI - Netlify Sürümü
=========================

Yerel açma (dev server, OpenAI chat dahil):
  npm install
  node dev-server.mjs
  -> http://127.0.0.1:5173

.env.local dosyasına şunları yaz:
  OPENAI_API_KEY=sk-...
  OPENAI_MODEL=gpt-4o-mini

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

=========================
KURAL AGENT (rule-agent.mjs)
=========================

Kural setleri (Avans Kapama, Ceza Havuzu, Çoklu Satıcı, Proje Limit) artık koddan değil
rules.json'dan beslenir. Kaynak: rules-docs/ klasöründeki .docx dosyaları.

İlk kurulum:
  npm install
  npm run init-docs        # rules-docs/ içine 4 örnek Word dosyası üretir

Agent'ı çalıştır (terminal açık kalmalı):
  npm run rules-agent              # değişiklikleri yakalar, onay sorar, dosyaya yazar
  npm run rules-agent:auto         # ek olarak otomatik git commit+push (Netlify auto-deploy)

Akış:
  1. rules-docs/avans-kapama.docx içine yeni mevzuat yazılır (Word ile düzenle, kaydet)
  2. Agent değişikliği yakalar -> OpenAI'a JSON schema ile structured extraction yaptırır
  3. Ajv ile yeni rules.json schema'sı doğrulanır
  4. Eski/yeni diff terminalde gösterilir
  5. [y/N] onayı beklenir
  6. Onaylanırsa rules.json + rules-context.json atomik olarak yazılır (.bak alır)
  7. (--auto-commit ile) git push -> Netlify yeniden deploy eder

Frontend (index.html) açılışta rules.json'u fetch eder; analiz fonksiyonu skor/bulgu/aksiyon
metinlerini bu dosyadan okur. Chat asistanı (chat.mjs) rules-context.json'dan ilgili Word
parçalarını system prompt'a enjekte eder (RAG).

Şema değişmediği sürece (rules-schema.json), denetçi koda dokunmadan kuralları güncelleyebilir.
