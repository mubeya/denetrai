// DenetrAI Rules Agent
// -----------------------------------------------------------------------------
// rules-docs/ klasöründeki .docx dosyalarını izler.
// Değişiklik olduğunda:
//   1) mammoth ile docx'i metne çevirir
//   2) OpenAI'a JSON Schema zorunlu structured output ile gönderir
//   3) Ajv ile yeni rules.json'u doğrular
//   4) Eski/yeni diff'i terminale gösterir
//   5) Kullanıcıdan [y/N] onayı ister
//   6) Onaylanırsa rules.json + rules-context.json'u atomik yazar (.bak alır)
//   7) --auto-commit verilmişse: git add + commit + push
//
// Kullanım:
//   node rule-agent.mjs            -> sadece dosya yaz
//   node rule-agent.mjs --auto-commit  -> ek olarak git commit + push
//
// CTRL+C ile durdurulur. Terminal açık kaldığı sürece çalışır.
// -----------------------------------------------------------------------------

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import chokidar from "chokidar";
import mammoth from "mammoth";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { diffLines } from "diff";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const DOCS_DIR = path.join(ROOT, "rules-docs");
const RULES_PATH = path.join(ROOT, "rules.json");
const CONTEXT_PATH = path.join(ROOT, "rules-context.json");
const SCHEMA_PATH = path.join(ROOT, "rules-schema.json");
const ENV_PATH = path.join(ROOT, ".env.local");

const ARGS = new Set(process.argv.slice(2));
const AUTO_COMMIT = ARGS.has("--auto-commit");

// ---- .env.local ----
if (fs.existsSync(ENV_PATH)) {
  for (const line of fs.readFileSync(ENV_PATH, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

if (!process.env.OPENAI_API_KEY) {
  console.error("HATA: OPENAI_API_KEY tanımlı değil (.env.local'a ekleyin).");
  process.exit(1);
}

const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

// ---- Schema yükle + Ajv hazırla ----
const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf8"));
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validateRules = ajv.compile(schema);

// ---- Yardımcılar ----
function readJsonSafe(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return fallback; }
}

function writeAtomic(p, content) {
  const tmp = p + ".tmp";
  const bak = p + ".bak";
  if (fs.existsSync(p)) fs.copyFileSync(p, bak);
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, p);
}

function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (ans) => { rl.close(); resolve(ans.trim().toLowerCase()); });
  });
}

function showDiff(label, oldText, newText) {
  console.log(`\n----- ${label} diff -----`);
  const parts = diffLines(oldText, newText);
  for (const part of parts) {
    const prefix = part.added ? "+ " : part.removed ? "- " : "  ";
    const color = part.added ? "\x1b[32m" : part.removed ? "\x1b[31m" : "\x1b[90m";
    const reset = "\x1b[0m";
    if (!part.added && !part.removed) {
      // sadece bağlam için ilk/son 2 satırı göster
      const lines = part.value.split("\n");
      if (lines.length > 6) {
        const head = lines.slice(0, 2).join("\n");
        const tail = lines.slice(-2).join("\n");
        process.stdout.write(color + head.split("\n").map(l => prefix + l).join("\n") + "\n  ...\n" +
          tail.split("\n").map(l => prefix + l).join("\n") + reset);
        continue;
      }
    }
    process.stdout.write(color + part.value.split("\n").map(l => l ? prefix + l : "").join("\n") + reset);
  }
  console.log(`----- ${label} diff sonu -----\n`);
}

function runGit(args) {
  return new Promise((resolve, reject) => {
    const p = spawn("git", args, { cwd: ROOT, stdio: "inherit" });
    p.on("close", (code) => code === 0 ? resolve() : reject(new Error(`git ${args.join(" ")} exit ${code}`)));
  });
}

// ---- docx -> text ----
async function docxToText(filePath) {
  const { value } = await mammoth.extractRawText({ path: filePath });
  return value.trim();
}

// ---- Control type tespiti (dosya adı veya başlık) ----
const FILE_TO_CONTROL = {
  "avans-kapama.docx":  "advance",
  "ceza-havuzu.docx":   "penalty",
  "coklu-satici.docx":  "seller",
  "proje-limit.docx":   "limit"
};
function controlTypeFor(fileName) {
  if (FILE_TO_CONTROL[fileName]) return FILE_TO_CONTROL[fileName];
  const lower = fileName.toLowerCase();
  if (lower.includes("avans"))   return "advance";
  if (lower.includes("ceza"))    return "penalty";
  if (lower.includes("satic"))   return "seller";
  if (lower.includes("limit"))   return "limit";
  return null;
}

// ---- LLM extraction ----
const EXTRACTION_SYSTEM = `Sen DenetrAI projesinin "Kural Çıkarım" ajanısın.
Görevin: kullanıcıdan gelen Türkçe serbest metin (bankacılık iç prosedür dokümanı) içinden
verilen control type için yapısal kural setini çıkarmaktır.

ÇOK ÖNEMLİ KURALLAR:
- ÇIKTI sadece geçerli JSON olacak, başka hiçbir metin yok.
- Şemaya tam uymayan alan EKLEME.
- Belirsiz veya bulamadığın senaryoları ÜRETME — eski JSON'daki halini koru. Kullanıcı sonra ekler.
- Sayısal eşikleri (skor, yüzde, gün) doğrudan metinden al; metinde yoksa eski değeri koru.
- "finding" / "action" / "impact" metinleri Türkçe olacak, profesyonel, kısa.
- Şablon değişkenleri (örn. \${correctClose}) varsa olduğu gibi koru.
- "context" alanına dokümanın "Açıklama" bölümünü kelime kelime kopyala (RAG için).`;

const EXTRACTION_USER_TEMPLATE = (controlType, docText, oldControl) => `
Control type: ${controlType}

Eski (mevcut) kural JSON'u (referans olarak kullan; metinde olmayan alanları KORU):
\`\`\`json
${JSON.stringify(oldControl, null, 2)}
\`\`\`

Yeni Word doküman metni:
\`\`\`
${docText}
\`\`\`

GÖREV: Bu doküman metnine göre güncellenmiş kural objesini (sadece "${controlType}" control için)
aşağıdaki yapıda DÖN:

{
  "control": "${controlType}",
  "data": {
    "label": "...",
    "context": "Açıklama bölümünün tam metni",
    "params": { ... },
    "scenarios": {
      "<senaryo_anahtarı>": { "score": <num>, "finding": "...", "action": "...", "impact": "..." },
      ...
    }
  },
  "ragChunks": [
    { "title": "...", "text": "..." }
  ]
}

ragChunks: dokümanı 1-3 anlamlı parçaya böl; chat asistanı bu parçaları soru-cevapta kullanacak.
SADECE bu JSON'u dön, başka hiçbir şey yazma.`;

async function callOpenAI(systemPrompt, userPrompt) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
        ],
        temperature: 0.1,
        response_format: { type: "json_object" },
        max_tokens: 2500
      }),
      signal: controller.signal
    });
    clearTimeout(timeout);
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`OpenAI ${res.status}: ${t.slice(0, 400)}`);
    }
    const data = await res.json();
    return data.choices?.[0]?.message?.content || "";
  } finally {
    clearTimeout(timeout);
  }
}

// ---- Tek dosyayı işle ----
async function processFile(filePath) {
  const fileName = path.basename(filePath);
  const control = controlTypeFor(fileName);
  if (!control) {
    console.warn(`[atlandı] ${fileName}: control type tespit edilemedi.`);
    return;
  }

  console.log(`\n=== Değişiklik: ${fileName} (control: ${control}) ===`);
  let docText;
  try {
    docText = await docxToText(filePath);
  } catch (e) {
    console.error(`[hata] docx okunamadı: ${e.message}`);
    return;
  }
  if (!docText || docText.length < 30) {
    console.warn(`[atlandı] ${fileName} içinde anlamlı metin yok.`);
    return;
  }

  const oldRules = readJsonSafe(RULES_PATH, null);
  const oldContext = readJsonSafe(CONTEXT_PATH, { version: "", chunks: [] });
  if (!oldRules) {
    console.error("[hata] rules.json okunamadı. Önce seed dosyayı oluşturun.");
    return;
  }
  const oldControl = oldRules.controls?.[control] || {};

  console.log("→ OpenAI'a gönderiliyor (structured extraction)...");
  let raw;
  try {
    raw = await callOpenAI(EXTRACTION_SYSTEM, EXTRACTION_USER_TEMPLATE(control, docText, oldControl));
  } catch (e) {
    console.error(`[hata] LLM çağrısı başarısız: ${e.message}`);
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    console.error(`[hata] LLM çıktısı JSON değil:\n${raw.slice(0, 500)}`);
    return;
  }
  if (!parsed?.data || parsed.control !== control) {
    console.error(`[hata] LLM beklenen yapıyı dönmedi.`);
    return;
  }

  // Yeni rules.json'u kur
  const newRules = JSON.parse(JSON.stringify(oldRules));
  newRules.controls[control] = parsed.data;
  newRules.version = new Date().toISOString();
  newRules.source = `agent: ${fileName}`;

  // Schema doğrulama
  const ok = validateRules(newRules);
  if (!ok) {
    console.error(`[hata] Yeni rules.json schema'ya uymuyor:`);
    for (const err of validateRules.errors) {
      console.error(`  - ${err.instancePath} ${err.message}`);
    }
    return;
  }

  // Yeni context (sadece bu control'un chunk'larını değiştir)
  const newContext = {
    version: newRules.version,
    chunks: [
      ...(oldContext.chunks || []).filter(c => c.control !== control),
      ...((parsed.ragChunks || []).map(c => ({
        control,
        source: fileName,
        title: c.title || control,
        text: c.text || ""
      })))
    ]
  };

  // Diff göster
  const oldRulesText = JSON.stringify(oldRules.controls[control] || {}, null, 2);
  const newRulesText = JSON.stringify(newRules.controls[control], null, 2);
  showDiff(`rules.controls.${control}`, oldRulesText, newRulesText);

  const ans = await ask(`Bu değişiklikleri uygulamak istiyor musunuz? [y/N]: `);
  if (ans !== "y" && ans !== "yes" && ans !== "e" && ans !== "evet") {
    console.log("İptal edildi. Dosyalar değişmedi.");
    return;
  }

  writeAtomic(RULES_PATH, JSON.stringify(newRules, null, 2));
  writeAtomic(CONTEXT_PATH, JSON.stringify(newContext, null, 2));
  console.log("✓ rules.json + rules-context.json güncellendi.");

  if (AUTO_COMMIT) {
    try {
      await runGit(["add", "rules.json", "rules-context.json", `rules-docs/${fileName}`]);
      await runGit(["commit", "-m", `chore(rules): ${control} güncellendi (${fileName})`]);
      await runGit(["push"]);
      console.log("✓ git commit + push tamam.");
    } catch (e) {
      console.error(`[uyarı] git işlemi başarısız: ${e.message}`);
    }
  } else {
    console.log("ℹ Otomatik commit kapalı. Manuel commit için: git add -A && git commit -m \"...\" && git push");
  }
}

// ---- Watcher ----
fs.mkdirSync(DOCS_DIR, { recursive: true });

console.log("DenetrAI Rules Agent başladı.");
console.log(`  İzlenen klasör: ${DOCS_DIR}`);
console.log(`  Model: ${OPENAI_MODEL}`);
console.log(`  Auto-commit: ${AUTO_COMMIT ? "AÇIK" : "kapalı"}`);
console.log(`  CTRL+C ile durdurun.\n`);

// Debounce: aynı dosya 2sn içinde tekrar tetiklenirse birleştir
const pending = new Map();
function schedule(filePath) {
  if (pending.has(filePath)) clearTimeout(pending.get(filePath));
  pending.set(filePath, setTimeout(async () => {
    pending.delete(filePath);
    try { await processFile(filePath); }
    catch (e) { console.error(`[hata] işleme sırasında: ${e.message}`); }
  }, 2000));
}

chokidar
  .watch(path.join(DOCS_DIR, "*.docx"), { ignoreInitial: true, awaitWriteFinish: { stabilityThreshold: 1500, pollInterval: 300 } })
  .on("add", (p) => { console.log(`[+] ${path.basename(p)}`); schedule(p); })
  .on("change", (p) => { console.log(`[~] ${path.basename(p)}`); schedule(p); })
  .on("error", (e) => console.error(`[watcher hata] ${e.message}`));

process.on("SIGINT", () => { console.log("\nKapanıyor..."); process.exit(0); });
