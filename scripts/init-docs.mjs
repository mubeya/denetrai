// Örnek .docx dosyalarını rules-docs/ klasörüne üretir.
// Kullanım: npm run init-docs
// Mevcut dosya varsa üzerine YAZMAZ — silmek istersen önce kendin sil.

import { Document, Packer, Paragraph, HeadingLevel, TextRun } from "docx";
import fs from "node:fs";
import path from "node:path";

const OUT_DIR = path.resolve("rules-docs");
fs.mkdirSync(OUT_DIR, { recursive: true });

const DOCS = [
  {
    file: "avans-kapama.docx",
    title: "Avans Kapama Kontrolü (control type: advance)",
    sections: [
      ["Açıklama",
        "Avans kapama denetimi, proje finansmanı için verilen avansın doğru süre içinde kapatılıp kapatılmadığını " +
        "denetler. Doğru kapama günü = vade gün × kural yüzdesi (varsayılan %30), azami 90 gün üst sınırı uygulanır. " +
        "Hafta sonuna denk gelen kapama tarihleri Pazartesi'ye çekilir. İstisna kayıtları komite onayı ile geçici " +
        "olarak tolere edilebilir; ancak istisna dayanağı (onay belgesi) ibraz edilmelidir."
      ],
      ["Parametreler",
        "Kural yüzdesi: %30",
        "Azami kapama günü: 90 gün",
        "Hafta sonu düzeltmesi: açık",
        "İstisna politikası: lower (yumuşak)"
      ],
      ["Senaryolar",
        "Aşım var, istisna yok: Kapama tarihi sınırı aşmış ve istisna kaydı bulunamadıysa risk yüksek. Azami günü " +
        "de geçtiyse skor 94, geçmediyse 80. Bulgu mesajı doğru kapama tarihi ve mevcut kayıt arasındaki farkı içermeli.",
        "Aşım var, istisna var ama dayanak belge yok: Skor katı politikada 76, yumuşak politikada 56. İstisna " +
        "dayanağının komite onay kaydıyla tamamlanması istenmeli.",
        "Aşım var, istisna ve dayanak belgesi var: Skor 42. Dayanak belgesi rapora eklenmeli, iz kayıtları korunmalı.",
        "Finansman tarihi eksik: Hesaplama yapılamaz. Skor 38. Excel'e Finansman Tarihi alanı eklenmeli.",
        "Uyumlu: Skor 16. Standart izleme yeterli."
      ]
    ]
  },
  {
    file: "ceza-havuzu.docx",
    title: "Ceza Havuzu Kontrolü (control type: penalty)",
    sections: [
      ["Açıklama",
        "Ceza havuzu, projenin uygun gelmeyen belge kısmı üzerinden hesaplanan cezai matrahtır. " +
        "Beklenen matrah = Proje Tutarı − Uygun Gelen Belge Tutarı. Sistemde kayıtlı matrah ile karşılaştırılır."
      ],
      ["Parametreler",
        "Büyük fark eşiği: proje tutarının %5'i"
      ],
      ["Senaryolar",
        "Uyumsuzluk - büyük fark: Fark proje tutarının %5'inden büyükse skor 86.",
        "Uyumsuzluk - küçük fark: Fark daha küçükse skor 65. Uygun belge tutarı ve cezaya konu proje tutarı yeniden hesaplanmalı.",
        "Uyumlu: Skor 16. Belge ayrıştırma ve uygunluk kayıtları izlenmeye devam edilmeli."
      ]
    ]
  },
  {
    file: "coklu-satici.docx",
    title: "Çoklu Satıcı Kontrolü (control type: seller)",
    sections: [
      ["Açıklama",
        "Bir projede birden fazla satıcı varsa, satıcı bazında ödeme tutarı ile fatura/belge tutarı eşleşmelidir. " +
        "Fark işareti riskin yönünü belirler: belge fazlaysa ceza havuzu yanlış hesaplanır, ödeme fazlaysa eksik belge riski oluşur."
      ],
      ["Parametreler",
        "Büyük fark eşiği: ödeme tutarının %15'i"
      ],
      ["Senaryolar",
        "Fazla belge - büyük fark: Belge tutarı ödemenin %15'inden çok fazlaysa skor 84.",
        "Fazla belge - küçük fark: Daha küçük fazlalıkta skor 62. Fazla belge gelen belge tutarına dahil edilmemeli.",
        "Eksik belge: Ödeme belgeden yüksekse skor 52. Eksik belge tamamlatılmalı veya ceza matrahı yeniden hesaplanmalı.",
        "Uyumlu: Skor 14. Standart izleme yeterli."
      ]
    ]
  },
  {
    file: "proje-limit.docx",
    title: "Proje Limit Kontrolü (control type: limit)",
    sections: [
      ["Açıklama",
        "Müşterinin aynı anda taşıyabileceği aktif proje adedi banka kredi politikası veya sözleşme tarafından " +
        "sınırlandırılır. Aşım, istisna ve komite onayı ile geçici tolere edilebilir; dayanak belge ibraz edilmelidir."
      ],
      ["Parametreler",
        "(Limit değeri her müşteri için Excel verisinden okunur, kural setinde sabit eşik yoktur.)"
      ],
      ["Senaryolar",
        "Aşım var, istisna yok: Skor 82. Yeni proje girişi durdurulmalı; limit, istisna ve komite onayı kontrol edilmeli.",
        "Aşım var, istisna var ama dayanak yok: Skor 58. Onay kapsamı ve geçerlilik süresi belgeyle doğrulanmalı.",
        "Aşım var, istisna ve dayanak var: Skor 42. Onay kapsamı rapora eklenmeli, iz kayıtları korunmalı.",
        "Uyumlu: Skor 14. Standart izleme yeterli."
      ]
    ]
  }
];

function buildDoc(spec) {
  const children = [];
  children.push(new Paragraph({ text: spec.title, heading: HeadingLevel.HEADING_1 }));
  for (const [heading, ...lines] of spec.sections) {
    children.push(new Paragraph({ text: heading, heading: HeadingLevel.HEADING_2 }));
    for (const line of lines) {
      children.push(new Paragraph({ children: [new TextRun(line)] }));
    }
  }
  return new Document({ sections: [{ children }] });
}

let wrote = 0, skipped = 0;
for (const spec of DOCS) {
  const out = path.join(OUT_DIR, spec.file);
  if (fs.existsSync(out)) { skipped++; console.log(`atlandı (zaten var): ${spec.file}`); continue; }
  const doc = buildDoc(spec);
  const buf = await Packer.toBuffer(doc);
  fs.writeFileSync(out, buf);
  wrote++;
  console.log(`oluşturuldu: ${spec.file}`);
}
console.log(`\nToplam: ${wrote} yazıldı, ${skipped} atlandı. Klasör: ${OUT_DIR}`);
