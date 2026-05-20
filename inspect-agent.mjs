// DenetrAI Teftiş Ajanı (Inspect Agent)
// -----------------------------------------------------------------------------
// data/projects.xlsx içindeki her proje satırını rules.json kurallarına göre
// puanlar; her riskli proje için kısa AI özet + aksiyon önerisi üretir;
// sonucu reports/latest.json'a yazar.
//
// Tetiklenme yolları:
//   1) GitHub Actions cron (saatlik) — workflow: inspect.yml
//   2) data/projects.xlsx push olunca   — workflow: inspect.yml
//   3) Lokal terminal:  npm run inspect
//   4) Anlık (UI):     /api/inspect-now (netlify/functions/inspect-now.mjs)
//
// Flags:
//   --once        tek seferlik tarama (varsayılan)
//   --ci          GitHub Actions modu (no-color, daha az log)
//   --no-ai       sadece deterministik kurallarla çalış (LLM çağırma)
//   --in <path>   alternatif Excel yolu
//   --out <path>  alternatif JSON yolu
// -----------------------------------------------------------------------------

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import XLSX from "xlsx";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname);
const DEFAULT_XLSX = path.join(ROOT, "data", "projects.xlsx");
const DEFAULT_OUT = path.join(ROOT, "reports", "latest.json");
const RULES_PATH = path.join(ROOT, "rules.json");
const ENV_PATH = path.join(ROOT, ".env.local");

// ---- args ----
const argv = process.argv.slice(2);
const FLAGS = new Set(argv.filter(a => a.startsWith("--") && !["--in", "--out"].includes(a)));
function argVal(name, def) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
}
const XLSX_PATH = path.resolve(argVal("--in", DEFAULT_XLSX));
const OUT_PATH = path.resolve(argVal("--out", DEFAULT_OUT));
const CI = FLAGS.has("--ci") || process.env.CI === "true";
const NO_AI = FLAGS.has("--no-ai");

// ---- .env.local ----
if (fs.existsSync(ENV_PATH)) {
  for (const line of fs.readFileSync(ENV_PATH, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

// ---- helpers ----
function log(...args) { if (!CI) console.log(...args); else console.log("[inspect]", ...args); }
function fmt(n) { return typeof n === "number" ? n.toLocaleString("tr-TR") : String(n ?? ""); }
function toBool(v) {
  if (typeof v === "boolean") return v;
  if (v == null) return false;
  const s = String(v).trim().toLowerCase();
  return ["e", "evet", "yes", "y", "true", "1", "var", "✓"].includes(s);
}
function toNum(v) {
  if (typeof v === "number") return v;
  if (v == null || v === "") return 0;
  const s = String(v).replace(/\./g, "").replace(",", ".").replace(/[^\d.\-]/g, "");
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}
function toDate(v) {
  if (!v) return null;
  if (v instanceof Date) return v;
  if (typeof v === "number") {
    // Excel serial
    const d = XLSX.SSF.parse_date_code(v);
    if (d) return new Date(Date.UTC(d.y, d.m - 1, d.d));
  }
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}
function fmtDate(d) { return d ? d.toISOString().slice(0, 10) : ""; }
function addDays(d, n) { const x = new Date(d); x.setUTCDate(x.getUTCDate() + n); return x; }

// ---- kontrol motorları (rules.json scenario'larını uygular) ----

function checkAdvance(row, rules) {
  const ctl = rules.controls.advance;
  const p = ctl.params || {};
  const percent = p.percent ?? 60;
  const maxDay = p.maxDay ?? 130;
  const adjustWeekend = p.adjustWeekend !== false;

  const vade = toNum(row.vade_gun);
  const startDate = toDate(row.finansman_tarihi);
  const closeDate = toDate(row.kapama_tarihi);
  const istisna = toBool(row.istisna);
  const dayanak = toBool(row.istisna_dayanak);

  if (!vade) {
    return { scenario: "missing_data", ...(ctl.scenarios.missing_start_date || { score: 30, finding: "Vade gün eksik.", action: "Eksik veri tamamlanmalı.", impact: "Otomatik kontrol güvenilirliği düşer." }) };
  }

  let correctDays = Math.min(Math.round(vade * percent / 100), maxDay);
  let correctClose = startDate ? addDays(startDate, correctDays) : null;
  if (adjustWeekend && correctClose) {
    const wd = correctClose.getUTCDay();
    if (wd === 6) correctClose = addDays(correctClose, 2);       // Cmt -> Pzt
    else if (wd === 0) correctClose = addDays(correctClose, 1);  // Paz -> Pzt
  }

  let scenario;
  if (!startDate) scenario = "missing_start_date";
  else {
    const actualDays = Math.round((closeDate - startDate) / 86400000);
    const exceeded = actualDays > correctDays;
    const overMax = actualDays > maxDay;
    if (!exceeded) scenario = "compliant";
    else if (istisna && dayanak) scenario = "exceeded_exception_with_doc";
    else if (istisna && !dayanak) scenario = "exceeded_exception_no_doc";
    else if (overMax) scenario = "exceeded_no_exception_max_day";
    else scenario = "exceeded_no_exception";
  }

  const s = ctl.scenarios[scenario] || ctl.scenarios.compliant;
  const score = s.score ?? (istisna ? (dayanak ? s.scoreLower : s.scoreStrict) : s.scoreStrict) ?? 0;
  const subst = (t) => (t || "").replace(/\$\{correctClose\}/g, fmtDate(correctClose));

  return {
    scenario, score,
    finding: subst(s.finding),
    action: subst(s.action),
    impact: s.impact || "",
    detail: { correctDays, correctClose: fmtDate(correctClose), maxDay, percent }
  };
}

function checkPenalty(row, rules) {
  const ctl = rules.controls.penalty;
  const p = ctl.params || {};
  const largeRatio = p.largeDiffRatio ?? 0.05;

  const proje = toNum(row.proje_tutari);
  const uygun = toNum(row.uygun_belge_tutari);
  const sistem = toNum(row.sistem_ceza_matrahi);
  const beklenen = Math.max(0, proje - uygun);
  const fark = Math.abs(beklenen - sistem);
  const ratio = proje > 0 ? fark / proje : 0;

  let scenario;
  if (fark < 1) scenario = "compliant";
  else if (ratio > largeRatio) scenario = "mismatch_large";
  else scenario = "mismatch_small";

  const s = ctl.scenarios[scenario];
  return {
    scenario, score: s.score ?? 0,
    finding: s.finding, action: s.action, impact: s.impact,
    detail: { beklenenMatrah: beklenen, sistemMatrahi: sistem, fark, fark_orani: +(ratio * 100).toFixed(2) }
  };
}

function checkSeller(row, rules) {
  const ctl = rules.controls.seller;
  const p = ctl.params || {};
  const largeRatio = p.largeDiffRatio ?? 0.15;

  const sayi = toNum(row.satici_sayisi);
  if (sayi <= 1) {
    const s = ctl.scenarios.compliant;
    return { scenario: "compliant_single", score: s.score ?? 10, finding: "Tek satıcı; çoklu satıcı kontrolü uygulanmaz.", action: s.action, impact: s.impact };
  }
  const belge = toNum(row.belge_tutari_toplam);
  const odeme = toNum(row.odeme_tutari_toplam);
  const fark = belge - odeme;             // + = fazla belge, - = eksik belge
  const base = Math.max(belge, odeme, 1);
  const ratio = Math.abs(fark) / base;

  let scenario;
  if (Math.abs(fark) < 1) scenario = "compliant";
  else if (fark > 0 && ratio > largeRatio) scenario = "excess_invoice";
  else if (fark < 0) scenario = "missing_invoice";
  else scenario = "compliant";

  const s = ctl.scenarios[scenario];
  return {
    scenario, score: s.score ?? 0,
    finding: s.finding, action: s.action, impact: s.impact,
    detail: { satici_sayisi: sayi, belge_toplam: belge, odeme_toplam: odeme, fark, fark_orani: +(ratio * 100).toFixed(2) }
  };
}

function checkLimit(row, rules) {
  const ctl = rules.controls.limit;
  const aktif = toNum(row.aktif_proje_sayisi);
  const limit = toNum(row.proje_limit);
  const istisna = toBool(row.istisna);
  const dayanak = toBool(row.istisna_dayanak);

  let scenario;
  if (limit > 0 && aktif > limit) {
    if (istisna && dayanak) scenario = "exceeded_exception_with_doc";
    else if (istisna && !dayanak) scenario = "exceeded_exception_no_doc";
    else scenario = "exceeded_no_exception";
  } else {
    scenario = "compliant";
  }

  const s = ctl.scenarios[scenario];
  const subst = (t) => (t || "")
    .replace(/\$\{projectLimit\}/g, String(limit))
    .replace(/\$\{activeProjectCount\}/g, String(aktif));
  return {
    scenario, score: s.score ?? 0,
    finding: subst(s.finding), action: subst(s.action), impact: s.impact,
    detail: { aktif_proje: aktif, limit }
  };
}

// ---- seviye eşikleri ----
function levelFor(score, sev) {
  if (score > (sev.criticalScoreAbove ?? 90)) return "kritik";
  if (score > (sev.highScoreAbove ?? 70)) return "yuksek";
  if (score > (sev.mediumScoreAbove ?? 40)) return "orta";
  return "dusuk";
}

// ---- LLM yönetici özeti ----
async function aiSummarize(items) {
  if (NO_AI || !process.env.OPENAI_API_KEY || !items.length) return new Map();

  const slim = items.map(it => ({
    proje_no: it.projeNo,
    musteri: it.musteri,
    seviye: it.level,
    toplam_skor: it.totalScore,
    bulgular: Object.entries(it.controls).map(([k, v]) => ({
      kontrol: k, skor: v.score, bulgu: v.finding
    }))
  }));

  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["projeler"],
    properties: {
      projeler: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["proje_no", "yonetici_ozeti", "oncelikli_aksiyon"],
          properties: {
            proje_no: { type: "string" },
            yonetici_ozeti: { type: "string", description: "1-2 cümlelik Türkçe risk özeti." },
            oncelikli_aksiyon: { type: "string", description: "Tek bir öncelikli aksiyon önerisi (Türkçe)." }
          }
        }
      }
    }
  };

  const body = {
    model: OPENAI_MODEL,
    temperature: 0.2,
    response_format: {
      type: "json_schema",
      json_schema: { name: "inspect_summaries", schema, strict: true }
    },
    messages: [
      { role: "system", content: "Sen Kuveyt Türk için çalışan bir teftiş analistisin. Türkçe, net, profesyonel cümleler kuruyorsun. Sadece JSON üret." },
      { role: "user", content: "Aşağıdaki proje risk özetlerine bak. Her proje için kısa bir yönetici özeti ve tek bir öncelikli aksiyon yaz.\n\n" + JSON.stringify(slim) }
    ]
  };

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    log("AI özet başarısız:", res.status, await res.text().catch(() => ""));
    return new Map();
  }
  const data = await res.json();
  let parsed;
  try { parsed = JSON.parse(data.choices[0].message.content); }
  catch { return new Map(); }
  const map = new Map();
  for (const p of parsed.projeler || []) map.set(p.proje_no, { ozet: p.yonetici_ozeti, aksiyon: p.oncelikli_aksiyon });
  return map;
}

// ---- ana akış ----
export async function runInspection({ xlsxPath = DEFAULT_XLSX, useAi = !NO_AI } = {}) {
  if (!fs.existsSync(xlsxPath)) throw new Error(`Excel bulunamadı: ${xlsxPath}`);
  if (!fs.existsSync(RULES_PATH)) throw new Error(`rules.json yok: ${RULES_PATH}`);

  const rules = JSON.parse(fs.readFileSync(RULES_PATH, "utf8"));
  const wb = XLSX.readFile(xlsxPath, { cellDates: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: "" });
  log(`Okundu: ${rows.length} proje (${path.basename(xlsxPath)})`);

  const items = rows.map((row, idx) => {
    const controls = {
      advance: checkAdvance(row, rules),
      penalty: checkPenalty(row, rules),
      seller:  checkSeller(row, rules),
      limit:   checkLimit(row, rules),
    };
    const totalScore = Math.round(
      0.4 * controls.advance.score +
      0.25 * controls.penalty.score +
      0.2 * controls.seller.score +
      0.15 * controls.limit.score
    );
    return {
      projeNo: row.proje_no || `SATIR-${idx + 1}`,
      musteri: row.musteri || "(belirtilmemiş)",
      totalScore,
      level: levelFor(totalScore, rules.severity || {}),
      raw: row,
      controls
    };
  });

  // En riskli ilk N için AI özet (maliyet kontrolü)
  const TOP_N = 20;
  const riskliler = [...items]
    .filter(it => it.level !== "dusuk")
    .sort((a, b) => b.totalScore - a.totalScore)
    .slice(0, TOP_N);

  let aiMap = new Map();
  if (useAi && riskliler.length) {
    log(`AI özeti isteniyor (${riskliler.length} proje)...`);
    aiMap = await aiSummarize(riskliler);
    log(`AI özeti alındı: ${aiMap.size} kayıt`);
  }
  for (const it of items) {
    const ai = aiMap.get(it.projeNo);
    if (ai) it.ai = ai;
  }

  const summary = {
    toplam: items.length,
    kritik: items.filter(i => i.level === "kritik").length,
    yuksek: items.filter(i => i.level === "yuksek").length,
    orta:   items.filter(i => i.level === "orta").length,
    dusuk:  items.filter(i => i.level === "dusuk").length,
  };

  return {
    generatedAt: new Date().toISOString(),
    rulesVersion: rules.version || null,
    source: path.basename(xlsxPath),
    summary,
    items: items.sort((a, b) => b.totalScore - a.totalScore)
  };
}

// CLI olarak çağrıldıysa çalış
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const report = await runInspection({ xlsxPath: XLSX_PATH, useAi: !NO_AI });
    const outDir = path.dirname(OUT_PATH);
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(OUT_PATH, JSON.stringify(report, null, 2) + "\n", "utf8");
    log(`✔ Rapor yazıldı: ${OUT_PATH}`);
    log(`  Kritik: ${report.summary.kritik}  Yüksek: ${report.summary.yuksek}  Orta: ${report.summary.orta}  Düşük: ${report.summary.dusuk}`);
  } catch (e) {
    console.error("HATA:", e.message);
    process.exit(1);
  }
}
