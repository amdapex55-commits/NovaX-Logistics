// NovaX rider voice notes: delete the files of locked notes (18 Oct 2026).
//
// A note is locked in the database (nv_parcel_voice.expired_at) the moment
// its parcel is returned to the shipper or delivered; from then on nobody can
// open it. Supabase does not let SQL delete storage files, so this function
// removes them through the Storage API and marks each note purged_at.
//
// It needs no secret: it only ever deletes files that nv_voice_purge_due()
// lists, which are already locked. Calling it early or twice does nothing
// harmful. pg_cron pokes it hourly when something is due
// (nv_voice_purge_tick in sql_novax_rider_voice_notes_phase3_20261018.sql).
// Deploy:  supabase functions deploy parcel-voice-purge --no-verify-jwt

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const BUCKET = "parcel-voice";
const PER_RUN = 100;

const headers = { "content-type": "application/json", apikey: SB_KEY, authorization: `Bearer ${SB_KEY}` };

async function rpc(fn: string, args: unknown) {
  const r = await fetch(`${SB_URL}/rest/v1/rpc/${fn}`, { method: "POST", headers, body: JSON.stringify(args) });
  const text = await r.text();
  if (!r.ok) throw new Error(`${fn} ${r.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("POST only", { status: 405 });
  try {
    const due: Array<{ id: string; storage_path: string }> = (await rpc("nv_voice_purge_due", { p_limit: PER_RUN })) ?? [];
    if (!due.length) return Response.json({ ok: true, purged: 0 });
    // Storage answers 200 with the objects it removed; a path that is already
    // gone is simply absent from that list, which still counts as purged.
    const del = await fetch(`${SB_URL}/storage/v1/object/${BUCKET}`, {
      method: "DELETE", headers, body: JSON.stringify({ prefixes: due.map((d) => d.storage_path) }),
    });
    if (!del.ok) throw new Error(`storage delete ${del.status}: ${(await del.text()).slice(0, 200)}`);
    const done = await rpc("nv_voice_purge_done", { p_ids: due.map((d) => d.id) });
    return Response.json({ ok: true, purged: done ?? 0 });
  } catch (e) {
    return Response.json({ ok: false, error: String((e as Error).message || e) }, { status: 500 });
  }
});
