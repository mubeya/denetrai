// Test: avans-kapama.docx'i değiştirir (yüzde %30 -> %35, azami 90 -> 100)
import { Document, Packer, Paragraph, HeadingLevel, TextRun } from "docx";
import fs from "node:fs";
import path from "node:path";

const sections = [
  ["Açıklama",
    "Avans kapama denetimi, proje finansmanı için verilen avansın doğru süre içinde " +
    "kapatılıp kapatılmadığını denetler. Doğru kapama günü = vade gün × kural yüzdesi " +
    "(GÜNCELLENDİ: varsayılan %35), azami 100 gün üst sınırı uygulanır. Hafta sonuna denk " +
    "gelen kapama tarihleri Pazartesi'ye çekilir. İstisna kayıtları komite onayı ile geçici " +
    "olarak tolere edilebilir; ancak istisna dayanağı (onay belgesi) ibraz edilmelidir."
  ],
  ["Parametreler",
    "Kural yüzdesi: %35",
    "Azami kapama günü: 100 gün",
    "Hafta sonu düzeltmesi: açık",
    "İstisna politikası: lower (yumuşak)"
  ],
  ["Senaryolar",
    "Aşım var, istisna yok: Kapama tarihi sınırı aşmış ve istisna kaydı bulunamadıysa risk yüksek. " +
    "Azami günü de geçtiyse skor 95, geçmediyse 85. Bulgu mesajı doğru kapama tarihi ve mevcut kayıt " +
    "arasındaki farkı içermeli.",
    "Aşım var, istisna var ama dayanak belge yok: Skor katı politikada 78, yumuşak politikada 58. " +
    "İstisna dayanağının komite onay kaydıyla tamamlanması istenmeli.",
    "Aşım var, istisna ve dayanak belgesi var: Skor 44. Dayanak belgesi rapora eklenmeli, iz kayıtları korunmalı.",
    "Finansman tarihi eksik: Hesaplama yapılamaz. Skor 40. Excel'e Finansman Tarihi alanı eklenmeli.",
    "Uyumlu: Skor 18. Standart izleme yeterli."
  ]
];

const children = [];
children.push(new Paragraph({ text: "Avans Kapama Kontrolü (control type: advance)", heading: HeadingLevel.HEADING_1 }));
for (const [h, ...lines] of sections) {
  children.push(new Paragraph({ text: h, heading: HeadingLevel.HEADING_2 }));
  for (const line of lines) children.push(new Paragraph({ children: [new TextRun(line)] }));
}
const doc = new Document({ sections: [{ children }] });
const buf = await Packer.toBuffer(doc);
const out = path.resolve("rules-docs/avans-kapama.docx");
fs.writeFileSync(out, buf);
console.log("Test: avans-kapama.docx güncellendi (%35, 100 gün, yeni skorlar).");
