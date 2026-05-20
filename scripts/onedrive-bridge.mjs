// DenetrAI OneDrive → Repo Köprüsü
// -----------------------------------------------------------------------------
// Kullanıcının lokal OneDrive (veya herhangi bir) klasöründeki .docx kural
// dosyalarını izler. Değişiklik olduğunda:
//   1) Dosyayı repo içindeki rules-docs/ klasörüne kopyalar
//   2) git add + commit + push yapar
//   3) Push, GitHub Actions "Rules Sync" workflow'unu tetikler
//   4) Agent LLM ile rules.json'u günceller, bot commit'ler, Netlify deploy eder
//
// Yapılandırma (.env.local veya ortam değişkeni):
//   ONEDRIVE_RULES_DIR=C:\Users\efirat\OneDrive\DenetrAI-Kurallar
//   ONEDRIVE_GIT_BRANCH=main             (opsiyonel, varsayılan main)
//   ONEDRIVE_DEBOUNCE_MS=4000            (opsiyonel, varsayılan 4 sn)
//
// Kullanım:
//   node scripts/onedrive-bridge.mjs           -> izlemeye başlar
//   node scripts/onedrive-bridge.mjs --once    -> bir kez senkronlayıp çıkar
//   node scripts/onedrive-bridge.mjs --dry     -> sadece logla, dosya yazma
//
// CTRL+C ile durdurulur. Terminal açık olduğu sürece çalışır.
// (Windows başlangıçta otomatik çalışsın istersen Görev Zamanlayıcı'ya ekle.)
// -----------------------------------------------------------------------------

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import chokidar from "chokidar";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const REPO_DOCS_DIR = path.join(ROOT, "rules-docs");
const ENV_PATH = path.join(ROOT, ".env.local");

const ARGS = new Set(process.argv.slice(2));
const ONCE = ARGS.has("--once");
const DRY = ARGS.has("--dry");

// ---- .env.local ----
if (fs.existsSync(ENV_PATH)) {
  for (const line of fs.readFileSync(ENV_PATH, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const SRC_DIR = process.env.ONEDRIVE_RULES_DIR;
const BRANCH = process.env.ONEDRIVE_GIT_BRANCH || "main";
const DEBOUNCE_MS = Number(process.env.ONEDRIVE_DEBOUNCE_MS || 4000);

if (!SRC_DIR) {
  console.error("HATA: ONEDRIVE_RULES_DIR tanımlı değil.");
  console.error("  .env.local dosyasına şunu ekleyin:");
  console.error("    ONEDRIVE_RULES_DIR=C:\\Users\\<kullanici>\\OneDrive\\DenetrAI-Kurallar");
  process.exit(1);
}

if (!fs.existsSync(SRC_DIR)) {
  console.error(`HATA: Kaynak klasör bulunamadı: ${SRC_DIR}`);
  console.error("  Klasörü oluşturun ve içine .docx kural dosyalarınızı koyun.");
  process.exit(1);
}

if (!fs.existsSync(REPO_DOCS_DIR)) {
  fs.mkdirSync(REPO_DOCS_DIR, { recursive: true });
}

console.log("DenetrAI OneDrive Köprüsü başladı");
console.log(`  Kaynak  : ${SRC_DIR}`);
console.log(`  Hedef   : ${REPO_DOCS_DIR}`);
console.log(`  Branch  : ${BRANCH}`);
console.log(`  Mod     : ${ONCE ? "ONCE" : "WATCH"}${DRY ? " (dry-run)" : ""}`);
console.log("");

// ---- yardımcılar ----
function isWatchable(file) {
  if (!file.toLowerCase().endsWith(".docx")) return false;
  if (path.basename(file).startsWith("~$")) return false;       // Office lock
  return true;
}

function sha(filePath) {
  // hash gerekmiyor; mtime+size yeterli — basit & taşınabilir
  const s = fs.statSync(filePath);
  return `${s.size}:${Math.floor(s.mtimeMs)}`;
}

function runGit(args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn("git", args, { cwd: ROOT, stdio: "pipe", ...opts });
    let out = "", err = "";
    p.stdout.on("data", d => (out += d));
    p.stderr.on("data", d => (err += d));
    p.on("close", code => {
      if (code === 0) resolve(out.trim());
      else reject(new Error(`git ${args.join(" ")} (exit ${code})\n${err}`));
    });
  });
}

async function copyAndPush(changedNames) {
  const copied = [];
  for (const name of changedNames) {
    const src = path.join(SRC_DIR, name);
    const dst = path.join(REPO_DOCS_DIR, name);
    if (!fs.existsSync(src)) continue;
    if (DRY) {
      console.log(`  [dry] kopyalanacak: ${name}`);
      copied.push(name);
      continue;
    }
    fs.copyFileSync(src, dst);
    copied.push(name);
    console.log(`  + kopyalandı: ${name}`);
  }
  if (!copied.length) return;
  if (DRY) {
    console.log("  [dry] git commit + push atlandı");
    return;
  }

  try {
    // staged değişiklik var mı?
    await runGit(["add", ...copied.map(n => `rules-docs/${n}`)]);
    const status = await runGit(["status", "--porcelain", "--", "rules-docs"]);
    if (!status) {
      console.log("  (içerik aynı, commit gereksiz)");
      return;
    }

    const msg = `chore(rules): OneDrive senkronu — ${copied.join(", ")}\n\nCo-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>`;
    await runGit(["commit", "-m", msg]);
    console.log("  ✔ commit oluşturuldu");

    // yarış durumuna karşı rebase + retry
    let lastErr;
    for (let i = 1; i <= 3; i++) {
      try {
        await runGit(["pull", "--rebase", "origin", BRANCH]);
        await runGit(["push", "origin", BRANCH]);
        console.log(`  ✔ push edildi (deneme ${i})`);
        console.log("  → GitHub Actions 'Rules Sync' tetiklenecek (1-2 dk).");
        return;
      } catch (e) {
        lastErr = e;
        console.log(`  ! push başarısız (deneme ${i}): ${e.message.split("\n")[0]}`);
        await new Promise(r => setTimeout(r, 2000));
      }
    }
    throw lastErr;
  } catch (e) {
    console.error("  ✗ git işlemi başarısız:", e.message);
  }
}

// ---- one-shot ----
if (ONCE) {
  const files = fs.readdirSync(SRC_DIR).filter(isWatchable);
  console.log(`Tek seferlik tarama: ${files.length} dosya`);
  await copyAndPush(files);
  process.exit(0);
}

// ---- izleyici ----
const seen = new Map();              // dosya adı -> son hash
const pending = new Set();           // bekleyen değişiklikler
let timer = null;

// İlk anda var olan dosyaları "bilinen" olarak işaretle ki başlangıçta gereksiz push olmasın.
for (const f of fs.readdirSync(SRC_DIR).filter(isWatchable)) {
  try { seen.set(f, sha(path.join(SRC_DIR, f))); } catch {}
}

function schedule(name) {
  pending.add(name);
  if (timer) clearTimeout(timer);
  timer = setTimeout(async () => {
    const batch = [...pending];
    pending.clear();
    timer = null;
    if (!batch.length) return;
    console.log(`\n[${new Date().toLocaleTimeString()}] değişiklik: ${batch.join(", ")}`);
    await copyAndPush(batch);
  }, DEBOUNCE_MS);
}

function onChange(filePath) {
  const name = path.basename(filePath);
  if (!isWatchable(name)) return;
  try {
    const h = sha(filePath);
    if (seen.get(name) === h) return;     // gerçekten değişmedi
    seen.set(name, h);
    schedule(name);
  } catch {
    // dosya kısa süreliğine kilitli olabilir (Word kaydederken) — sonraki event'te yakalanır
  }
}

const watcher = chokidar.watch(SRC_DIR, {
  depth: 0,
  ignoreInitial: true,
  awaitWriteFinish: { stabilityThreshold: 1500, pollInterval: 300 },
});

watcher
  .on("ready", () => console.log(`İzleniyor: ${SRC_DIR}\n(Word'ü kaydet → otomatik commit+push → CI agent → site güncelleme)\n`))
  .on("add", onChange)
  .on("change", onChange)
  .on("error", e => console.error("watcher hatası:", e.message));

process.on("SIGINT", () => {
  console.log("\nKöprü durduruluyor...");
  watcher.close().finally(() => process.exit(0));
});
