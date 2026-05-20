// Netlify Function: /.netlify/functions/chat
// netlify.toml ile /api/chat -> /.netlify/functions/chat yönlendirmesi var, frontend değişmez.

const RATE_LIMIT = { windowMs: 60_000, max: 20 };
const hits = new Map();

function rateLimited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter(t => now - t < RATE_LIMIT.windowMs);
  arr.push(now);
  hits.set(ip, arr);
  return arr.length > RATE_LIMIT.max;
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
  const sys = (typeof systemPrompt === "string" && systemPrompt.trim())
    ? systemPrompt.slice(0, 8000)
    : "Sen bir denetim asistanısın.";

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
    return json(200, { reply: data.choices?.[0]?.message?.content || "Yanıt alınamadı." });
  } catch (err) {
    console.error(err);
    const msg = err.name === "AbortError" ? "AI yanıtı zaman aşımına uğradı" : "Sunucu hatası";
    return json(500, { error: msg });
  }
};
