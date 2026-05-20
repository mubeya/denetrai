// Yerel geliştirme sunucusu:
// - Statik dosyaları servis eder (index.html, vs.)
// - POST /api/chat çağrılarını netlify/functions/chat.mjs içine yönlendirir
// - OPENAI_API_KEY'i .env.local dosyasından okur
//
// Kullanım:
//   1) Bu klasörde .env.local oluştur, içeriği:
//        OPENAI_API_KEY=sk-...
//        OPENAI_MODEL=gpt-4o-mini
//   2) node dev-server.mjs
//   3) http://127.0.0.1:5173

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 5173;

// .env.local yükle
const envPath = path.join(__dirname, ".env.local");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  console.log(".env.local yüklendi");
} else {
  console.warn("UYARI: .env.local bulunamadı. OPENAI_API_KEY tanımlı değilse chat çalışmaz.");
}

const { handler } = await import("./netlify/functions/chat.mjs");
const inspectNow = (await import("./netlify/functions/inspect-now.mjs")).default;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js":   "application/javascript; charset=utf-8",
  ".mjs":  "application/javascript; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".png":  "image/png",
  ".jpg":  "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg":  "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".ico":  "image/x-icon"
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

http.createServer(async (req, res) => {
  // API: /api/inspect-now -> netlify function (Web Fetch API style)
  if (req.url.startsWith("/api/inspect-now") || req.url.startsWith("/.netlify/functions/inspect-now")) {
    try {
      const fullUrl = `http://127.0.0.1:${PORT}${req.url}`;
      const webReq = new Request(fullUrl, { method: req.method, headers: req.headers });
      const response = await inspectNow(webReq);
      const text = await response.text();
      const headers = {};
      response.headers.forEach((v, k) => { headers[k] = v; });
      res.writeHead(response.status, headers);
      res.end(text);
    } catch (err) {
      console.error("inspect-now error:", err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(err) }));
    }
    return;
  }

  // API: /api/chat -> netlify function handler
  if (req.url.startsWith("/api/chat") || req.url.startsWith("/.netlify/functions/chat")) {
    try {
      const body = await readBody(req);
      const event = {
        httpMethod: req.method,
        headers: req.headers,
        body
      };
      const result = await handler(event);
      res.writeHead(result.statusCode || 200, result.headers || {});
      res.end(result.body || "");
    } catch (err) {
      console.error("Function error:", err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Sunucu hatası", detail: String(err) }));
    }
    return;
  }

  // Statik dosyalar
  let urlPath = decodeURIComponent(req.url.split("?")[0]);
  if (urlPath === "/" || !path.extname(urlPath)) urlPath = "/index.html";
  const filePath = path.join(__dirname, urlPath);
  if (!filePath.startsWith(__dirname)) { res.writeHead(403).end(); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      // SPA fallback
      fs.readFile(path.join(__dirname, "index.html"), (e2, d2) => {
        if (e2) { res.writeHead(404).end("Not found"); return; }
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(d2);
      });
      return;
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream" });
    res.end(data);
  });
}).listen(PORT, "127.0.0.1", () => {
  console.log(`DenetrAI yerel sunucu: http://127.0.0.1:${PORT}`);
  console.log(`OPENAI_API_KEY: ${process.env.OPENAI_API_KEY ? "✓ yüklendi" : "✗ EKSİK"}`);
});
