// Daily, bounded metadata maintenance. No room/business writes or search.list.
// verify_jwt=false: one-use 256-bit job capabilities are issued only by pg_cron.
import { readBodyLimited, serviceHeaders } from "../hana-karaoke/index.ts";
type Obj = Record<string, unknown>;
const object = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);
const reply = (status: number, body: Obj) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json", "cache-control": "no-store" },
});
function key(): string {
  try {
    const values = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}");
    if (typeof values.default === "string" && values.default) return values.default;
  } catch { /* Legacy project compatibility. */ }
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!legacy) throw new Error("Unavailable");
  return legacy;
}
async function rpc(url: string, secret: string, name: string, data: Obj): Promise<unknown> {
  const r = await fetch(`${url}/rest/v1/rpc/${name}`, {
    method: "POST", headers: serviceHeaders(secret), body: JSON.stringify(data),
    signal: AbortSignal.timeout(8000), redirect: "error",
  });
  if (!r.ok) throw new Error("Database unavailable");
  return r.json();
}
function text(value: unknown, max: number): string {
  return typeof value === "string" ? [...value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, "").trim()].slice(0, max).join("") : "";
}
export function metadata(value: unknown, requested: string[]): { items: Obj[]; removed: string[] } {
  if (!object(value) || !Array.isArray(value.items)) throw new Error("Invalid provider data");
  const allowed = new Set(requested), found = new Map<string, Obj>();
  for (const v of value.items) {
    if (!object(v) || typeof v.id !== "string" || !allowed.has(v.id) || !object(v.status) || !object(v.snippet) || !object(v.contentDetails)) continue;
    const region = object(v.contentDetails.regionRestriction) ? v.contentDetails.regionRestriction : {};
    if (v.status.privacyStatus !== "public" || v.status.embeddable !== true ||
      (Array.isArray(region.blocked) && region.blocked.includes("VN")) ||
      (Array.isArray(region.allowed) && !region.allowed.includes("VN"))) continue;
    const duration = String(v.contentDetails.duration || "").match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
    const seconds = duration ? Number(duration[1] || 0) * 3600 + Number(duration[2] || 0) * 60 + Number(duration[3] || 0) : 0;
    const title = text(v.snippet.title, 500);
    if (!title || seconds < 1 || seconds > 86400) continue;
    found.set(v.id, { videoId: v.id, title, channelTitle: text(v.snippet.channelTitle, 300), durationSeconds: seconds });
  }
  return { items: [...found.values()], removed: requested.filter(id => !found.has(id)) };
}
export async function handler(req: Request): Promise<Response> {
  if (req.method !== "POST") return reply(405, { error: "Use POST" });
  try {
    const data = await readBodyLimited(req);
    if (!object(data) || Object.keys(data).length !== 1 || typeof data.token !== "string" || !/^[a-f0-9]{64}$/.test(data.token)) return reply(404, { error: "Invalid job" });
    const url = (Deno.env.get("SUPABASE_URL") || "").replace(/\/$/, ""), secret = key();
    if (!url) throw new Error("Unavailable");
    const job = await rpc(url, secret, "hana_karaoke_catalog_refresh_claim", { p_token: data.token });
    if (!object(job) || typeof job.leaseId !== "string" || !Array.isArray(job.videoIds) || job.videoIds.length > 200 ||
      !job.videoIds.every(id => typeof id === "string" && /^[A-Za-z0-9_-]{11}$/.test(id))) return reply(404, { error: "Invalid job" });
    const youtube = Deno.env.get("YOUTUBE_API_KEY");
    if (!youtube) throw new Error("Unavailable");
    const items: Obj[] = [], removed: string[] = [];
    for (let offset = 0; offset < job.videoIds.length; offset += 50) {
      const batch = (job.videoIds as string[]).slice(offset, offset + 50);
      const endpoint = new URL("https://www.googleapis.com/youtube/v3/videos");
      endpoint.search = new URLSearchParams({ part: "snippet,status,contentDetails", id: batch.join(","),
        fields: "items(id,snippet(title,channelTitle),status(privacyStatus,embeddable),contentDetails(duration,regionRestriction))" }).toString();
      const r = await fetch(endpoint.href, { headers: { "x-goog-api-key": youtube }, signal: AbortSignal.timeout(6000), redirect: "error" });
      if (!r.ok) throw new Error("Provider unavailable");
      const fresh = metadata(await r.json(), batch); items.push(...fresh.items); removed.push(...fresh.removed);
    }
    const result = await rpc(url, secret, "hana_karaoke_catalog_refresh_finish", { p_lease: job.leaseId, p_items: items, p_removed: removed });
    return reply(200, object(result) ? result : {});
  } catch { return reply(503, { error: "Catalogue maintenance unavailable" }); }
}
if (import.meta.main) Deno.serve(handler);

