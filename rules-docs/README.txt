DenetrAI Kural Kaynak Dokümanları
==================================

Bu klasördeki .docx dosyaları kural setlerinin KAYNAĞIDIR. Denetçi mevzuat veya iç prosedür
değişince ilgili Word'ü düzenleyip kaydeder. `npm run rules-agent` çalışıyorsa otomatik olarak:

  1. Word değişikliğini yakalar (chokidar)
  2. Metni çıkarır (mammoth)
  3. OpenAI ile yapısal kurallara çevirir (JSON schema zorunlu)
  4. Eski/yeni rules.json farkını terminale gösterir
  5. ONAY ister (y/N)
  6. Onaylanırsa rules.json + rules-context.json günceller
  7. (Opsiyonel --auto-commit) git commit + push -> Netlify auto-deploy

Word dosyaları SERBEST FORMATTA yazılabilir; ama LLM'in doğru çıkarım yapabilmesi için
şu başlıkları içermeleri ÖNERİLİR:

  - Kural Adı
  - Açıklama (RAG için chat asistanı bu metni kullanır)
  - Parametreler (sayısal eşik değerler; örn. "yüzde 30", "90 gün")
  - Senaryolar (durum -> skor + bulgu + aksiyon + etki)

Örnek dosyalar:
  avans-kapama.docx     -- Avans kapama kuralları (control type: advance)
  ceza-havuzu.docx      -- Ceza havuzu kuralları (control type: penalty)
  coklu-satici.docx     -- Çoklu satıcı kontrolü (control type: seller)
  proje-limit.docx      -- Proje limit kontrolü  (control type: limit)

İlk kurulumda örnek Word'leri üretmek için:
  npm run init-docs

Agent'ı başlatmak için:
  npm run rules-agent
