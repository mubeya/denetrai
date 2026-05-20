// Netlify Function: /.netlify/functions/inspect-now
// Anlık teftiş — data/projects.xlsx'i okuyup risk raporunu döndürür.
// İsteğe bağlı OpenAI ile yönetici özeti eklenir (OPENAI_API_KEY varsa).
// Cache: aynı dosya hash'i için 60 sn cache; "force=1" ile bypass.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runInspection } from "../../inspect-agent.mjs";

let cache = null; // { mtime, expires, report }

function findXlsx() {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(__dirname, "../../data/projects.xlsx"),
    path.resolve(process.cwd(), "data/projects.xlsx"),
  ];
  for (const p of candidates) if (fs.existsSync(p)) return p;
  return null;
}

export default async (req) => {
  const url = new URL(req.url);
  const force = url.searchParams.get("force") === "1";
  const noAi = url.searchParams.get("ai") === "0";

  const xlsxPath = findXlsx();
  if (!xlsxPath) {
    return new Response(JSON.stringify({ error: "data/projects.xlsx bulunamadı" }), {
      status: 500, headers: { "content-type": "application/json" }
    });
  }

  try {
    const stat = fs.statSync(xlsxPath);
    if (!force && cache && cache.mtime === stat.mtimeMs && cache.expires > Date.now()) {
      return new Response(JSON.stringify({ cached: true, ...cache.report }), {
        headers: { "content-type": "application/json" }
      });
    }

    const report = await runInspection({ xlsxPath, useAi: !noAi });
    cache = { mtime: stat.mtimeMs, expires: Date.now() + 60_000, report };
    return new Response(JSON.stringify({ cached: false, ...report }), {
      headers: { "content-type": "application/json" }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500, headers: { "content-type": "application/json" }
    });
  }
};
