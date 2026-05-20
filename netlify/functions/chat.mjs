// Netlify Function: /.netlify/functions/chat
// netlify.toml ile /api/chat -> /.netlify/functions/chat yönlendirmesi var, frontend değişmez.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RATE_LIMIT = { windowMs: 60_000, max: 20 };
const hits = new Map();

function rateLimited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter(t => now - t < RATE_LIMIT.windowMs);
  arr.push(now);
  hits.set(ip, arr);
  return arr.length > RATE_LIMIT.max;
}

// ===== RAG context (rules-context.json) =====
// Function cold start'ta tek sefer yüklenir, bellekte cache.
let RAG_CONTEXT = null;
function loadRagContext() {
  if (RAG_CONTEXT) return RAG_CONTEXT;
  try {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    // Netlify functions çalışma klasörü değişken; birkaç olası yol dene.
    const candidates = [
      path.resolve(__dirname, "../../rules-context.json"),
      path.resolve(process.cwd(), "rules-context.json"),
      path.resolve(__dirname, "rules-context.json")
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) {
        RAG_CONTEXT = JSON.parse(fs.readFileSync(p, "utf8"));
        console.log(`RAG context yüklendi: ${p} (${RAG_CONTEXT.chunks?.length || 0} chunk)`);
        return RAG_CONTEXT;
      }
    }
    console.warn("rules-context.json bulunamadı, RAG devre dışı.");
  } catch (e) {
    console.warn("rules-context.json okunamadı:", e.message);
  }
  RAG_CONTEXT = { chunks: [] };
  return RAG_CONTEXT;
}

function tokenize(s) {
  return String(s || "").toLocaleLowerCase("tr-TR")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/).filter(t => t.length > 2);
}
function pickRelevantChunks(query, k = 3) {
  const ctx = loadRagContext();
  if (!ctx?.chunks?.length) return [];
  const qTokens = new Set(tokenize(query));
  if (qTokens.size === 0) return ctx.chunks.slice(0, k);
  const scored = ctx.chunks.map(c => {
    const cTokens = tokenize((c.title || "") + " " + (c.text || ""));
    let score = 0;
    for (const t of cTokens) if (qTokens.has(t)) score++;
    // Kontrol tipi anahtar kelimeleri ekstra ağırlık
    const controlHints = {
      advance: ["avans","kapama","vade","gün"],
      penalty: ["ceza","havuz","matrah","belge"],
      seller:  ["satıcı","satici","fatura","ödeme","odeme"],
      limit:   ["limit","proje","aktif","adet"]
    };
    for (const h of (controlHints[c.control] || [])) {
      if (qTokens.has(h)) score += 2;
    }
    return { c, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.filter(s => s.score > 0).slice(0, k).map(s => s.c);
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

function json(statusCode, body) {
  return { statusCode, headers: { "Content-Type": "application/json", ...CORS }, body: JSON.stringify(body) };
}

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: CORS, body: "" };
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });

  const ip = (event.headers["x-forwarded-for"] || event.headers["client-ip"] || "unknown").split(",")[0].trim();
  if (rateLimited(ip)) return json(429, { error: "Çok fazla istek. Lütfen biraz bekleyin." });

  let payload;
  try { payload = JSON.parse(event.body || "{}"); }
  catch { return json(400, { error: "Geçersiz JSON" }); }

  const { messages, systemPrompt } = payload;
  if (!Array.isArray(messages) || messages.length === 0) {
    return json(400, { error: "Geçersiz istek" });
  }

  const safeMessages = messages
    .filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .map(m => ({ role: m.role, content: m.content.slice(0, 4000) }))
    .slice(-10);

  if (safeMessages.length === 0) return json(400, { error: "Geçerli mesaj bulunamadı" });

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return json(503, { error: "AI servisi yapılandırılmamış" });

  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
  let sys = (typeof systemPrompt === "string" && systemPrompt.trim())
    ? systemPrompt.slice(0, 8000)
    : "Sen bir denetim asistanısın.";

  // RAG: son kullanıcı mesajına göre ilgili Word chunk'larını ekle
  const lastUser = [...safeMessages].reverse().find(m => m.role === "user");
  const ragChunks = lastUser ? pickRelevantChunks(lastUser.content, 3) : [];
  if (ragChunks.length) {
    const ragText = ragChunks.map(c =>
      `[${c.control}/${c.source}] ${c.title}\n${c.text}`
    ).join("\n\n");
    sys = sys + `\n\n=== KURAL DOKÜMAN KAYNAKLARI (RAG) ===\nAşağıdaki alıntılar Word kural dokümanlarından çıkarılmıştır. Yanıt verirken bu kaynaklara dayan ve gerekirse atıf yap.\n\n${ragText}`;
    sys = sys.slice(0, 12000);
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25_000);

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "system", content: sys }, ...safeMessages],
        max_tokens: 800,
        temperature: 0.2
      }),
      signal: controller.signal
    });
    clearTimeout(timeout);

    if (!response.ok) {
      const errText = await response.text();
      console.error("OpenAI hata:", response.status, errText);
      return json(response.status, { error: "AI servisinden hata alındı" });
    }

    const data = await response.json();
    return json(200, {
      reply: data.choices?.[0]?.message?.content || "Yanıt alınamadı.",
      ragSources: ragChunks.map(c => ({ control: c.control, title: c.title, source: c.source }))
    });
  } catch (err) {
    console.error(err);
    const msg = err.name === "AbortError" ? "AI yanıtı zaman aşımına uğradı" : "Sunucu hatası";
    return json(500, { error: msg });
  }
};
