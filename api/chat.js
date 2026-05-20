// Basit in-memory rate limit (Vercel'de soğuk başlatma sıfırlar; gerçek üretim için Upstash önerilir).
const RATE_LIMIT = { windowMs: 60_000, max: 20 };
const hits = new Map();

function rateLimited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter(t => now - t < RATE_LIMIT.windowMs);
  arr.push(now);
  hits.set(ip, arr);
  return arr.length > RATE_LIMIT.max;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const ip = (req.headers["x-forwarded-for"] || "unknown").split(",")[0].trim();
  if (rateLimited(ip)) {
    return res.status(429).json({ error: "Çok fazla istek. Lütfen biraz bekleyin." });
  }

  const { messages, systemPrompt } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: "Geçersiz istek" });
  }

  // Prompt-injection koruması: yalnızca user/assistant rollerini kabul et, sistem mesajını sunucu belirler.
  const safeMessages = messages
    .filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .map(m => ({ role: m.role, content: m.content.slice(0, 4000) }))
    .slice(-10);

  if (safeMessages.length === 0) {
    return res.status(400).json({ error: "Geçerli mesaj bulunamadı" });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return res.status(503).json({ error: "AI servisi yapılandırılmamış" });

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
      return res.status(response.status).json({ error: "AI servisinden hata alındı" });
    }

    const data = await response.json();
    return res.status(200).json({
      reply: data.choices?.[0]?.message?.content || "Yanıt alınamadı."
    });
  } catch (err) {
    console.error(err);
    const msg = err.name === "AbortError" ? "AI yanıtı zaman aşımına uğradı" : "Sunucu hatası";
    return res.status(500).json({ error: msg });
  }
}
