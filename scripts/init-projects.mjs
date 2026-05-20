// DenetrAI - Örnek projects.xlsx üreticisi
// scripts/init-projects.mjs
// Çalıştır: npm run init-projects

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import XLSX from "xlsx";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const XLSX_PATH = path.join(DATA_DIR, "projects.xlsx");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// Senaryolar bilinçli olarak farklı risk seviyelerinde
const rows = [
  {
    proje_no: "PRJ-2026-001", musteri: "ABC İnşaat A.Ş.",
    finansman_tarihi: "2025-12-01", vade_gun: 365, kapama_tarihi: "2026-04-10",
    istisna: "H", istisna_dayanak: "H",
    proje_tutari: 5000000, uygun_belge_tutari: 4200000, sistem_ceza_matrahi: 800000,
    satici_sayisi: 1, belge_tutari_toplam: 4200000, odeme_tutari_toplam: 4200000,
    aktif_proje_sayisi: 3, proje_limit: 5
  },
  {
    proje_no: "PRJ-2026-002", musteri: "Doğa Enerji Ltd.",
    finansman_tarihi: "2025-09-15", vade_gun: 180, kapama_tarihi: "2026-05-20",
    istisna: "E", istisna_dayanak: "H",
    proje_tutari: 12000000, uygun_belge_tutari: 9000000, sistem_ceza_matrahi: 2400000,
    satici_sayisi: 4, belge_tutari_toplam: 9000000, odeme_tutari_toplam: 7200000,
    aktif_proje_sayisi: 7, proje_limit: 5
  },
  {
    proje_no: "PRJ-2026-003", musteri: "Mavi Liman Tic.",
    finansman_tarihi: "2026-01-10", vade_gun: 365, kapama_tarihi: "2026-04-15",
    istisna: "H", istisna_dayanak: "H",
    proje_tutari: 800000, uygun_belge_tutari: 780000, sistem_ceza_matrahi: 20000,
    satici_sayisi: 1, belge_tutari_toplam: 780000, odeme_tutari_toplam: 780000,
    aktif_proje_sayisi: 1, proje_limit: 3
  },
  {
    proje_no: "PRJ-2026-004", musteri: "Yıldız Üretim A.Ş.",
    finansman_tarihi: "2025-06-01", vade_gun: 360, kapama_tarihi: "2026-07-01",
    istisna: "H", istisna_dayanak: "H",
    proje_tutari: 25000000, uygun_belge_tutari: 18000000, sistem_ceza_matrahi: 5000000,
    satici_sayisi: 6, belge_tutari_toplam: 18000000, odeme_tutari_toplam: 21000000,
    aktif_proje_sayisi: 4, proje_limit: 5
  },
  {
    proje_no: "PRJ-2026-005", musteri: "Kuzey Tekstil Ltd.",
    finansman_tarihi: "2025-11-20", vade_gun: 270, kapama_tarihi: "2026-05-15",
    istisna: "E", istisna_dayanak: "E",
    proje_tutari: 3500000, uygun_belge_tutari: 3300000, sistem_ceza_matrahi: 200000,
    satici_sayisi: 2, belge_tutari_toplam: 3300000, odeme_tutari_toplam: 3290000,
    aktif_proje_sayisi: 2, proje_limit: 4
  },
  {
    proje_no: "PRJ-2026-006", musteri: "Anadolu Gıda San.",
    finansman_tarihi: "2025-08-05", vade_gun: 365, kapama_tarihi: "2026-07-10",
    istisna: "H", istisna_dayanak: "H",
    proje_tutari: 7500000, uygun_belge_tutari: 4800000, sistem_ceza_matrahi: 1900000,
    satici_sayisi: 3, belge_tutari_toplam: 4800000, odeme_tutari_toplam: 4790000,
    aktif_proje_sayisi: 8, proje_limit: 5
  },
];

const header = [
  "proje_no", "musteri",
  "finansman_tarihi", "vade_gun", "kapama_tarihi",
  "istisna", "istisna_dayanak",
  "proje_tutari", "uygun_belge_tutari", "sistem_ceza_matrahi",
  "satici_sayisi", "belge_tutari_toplam", "odeme_tutari_toplam",
  "aktif_proje_sayisi", "proje_limit"
];

const ws = XLSX.utils.json_to_sheet(rows, { header });
ws["!cols"] = header.map(h => ({ wch: Math.max(h.length + 2, 14) }));

const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, ws, "Projeler");
XLSX.writeFile(wb, XLSX_PATH);

console.log(`✔ ${rows.length} satır yazıldı: ${XLSX_PATH}`);
console.log("Kolonlar:");
for (const h of header) console.log("  - " + h);
