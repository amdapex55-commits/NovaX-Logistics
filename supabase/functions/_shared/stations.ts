/* Stations NovaX delivers to (17 Oct 2026).
 *
 * The first four are where riders also collect (pickup). The eight new
 * stations opened on 17 Oct 2026 as delivery destinations only. All of them
 * except Karachi are Zone B: novax_quote_fee and nv_book_parcel_core price
 * by "is the destination Karachi", so no pricing change was needed.
 *
 * The same list lives in client-app.js, admin.html, index.html and
 * rider-core.js, and admin_add_rider / admin_set_rider_cities accept exactly
 * these names (sql_novax_new_stations_20261017.sql). Keep them together.
 */
export const STATIONS_CORE = ["Karachi", "Lahore", "Islamabad", "Rawalpindi"];
export const STATIONS_NEW = ["Faisalabad", "Multan", "Sahiwal", "Okara", "Chichawatni", "Harappa", "Yousuf Wala", "Adda Gamber"];
export const STATIONS_ALL = [...STATIONS_CORE, ...STATIONS_NEW];

/** Spellings merchants and stores send, mapped to the station name. */
const ALIASES: Record<string, string> = {
  "pindi": "Rawalpindi", "rwp": "Rawalpindi", "isb": "Islamabad", "lhr": "Lahore", "khi": "Karachi",
  "lyallpur": "Faisalabad", "faisal abad": "Faisalabad", "fsd": "Faisalabad",
  "harrapa": "Harappa", "harapa": "Harappa", "harrappa": "Harappa",
  "yousufwala": "Yousuf Wala", "yousaf wala": "Yousuf Wala", "yousafwala": "Yousuf Wala", "yusuf wala": "Yousuf Wala",
  "yusufwala": "Yousuf Wala", "yousuf-wala": "Yousuf Wala", "yousaf-wala": "Yousuf Wala",
  "adda gambar": "Adda Gamber", "gamber": "Adda Gamber", "gambar": "Adda Gamber", "adda-gamber": "Adda Gamber",
  "chicha watni": "Chichawatni", "chichawatney": "Chichawatni",
};

function exactStation(k: string): string | null {
  if (!k) return null;
  return STATIONS_ALL.find((c) => c.toLowerCase() === k) ?? ALIASES[k] ?? null;
}
const norm = (v: string) => v.toLowerCase().replace(/[.]/g, " ").replace(/\s+/g, " ").trim();
/* Words stores add around the town: province, country, "district", a postcode.
 * "Sahiwal, Punjab", "Multan Punjab 60000", "Okara District" are the town. */
const NOISE = /\b(punjab|sindh|kpk|khyber pakhtunkhwa|pakistan|pk|ict|district|distt|dist|city|tehsil|division|cantt|cantonment)\b|\d+/g;
/* A small station and its district written together ("Chichawatni, Sahiwal",
 * "Adda Gamber, Okara") is the small town, not two cities. */
const DISTRICT_OF: Record<string, string> = {
  "Harappa": "Sahiwal", "Chichawatni": "Sahiwal", "Yousuf Wala": "Sahiwal", "Adda Gamber": "Okara",
};

/** The station a city field names ("multan", "Yousaf Wala", "Sahiwal, Punjab"),
 *  or null. Two different stations in one field ("Lahore, Multan") is null:
 *  never a guess. */
export function stationName(raw: unknown): string | null {
  const whole = norm(String(raw ?? "").replace(/,/g, " "));
  const hit = exactStation(whole);
  if (hit) return hit;
  const found = new Set<string>();
  for (const part of String(raw ?? "").split(/[,/|;]+/)) {
    const k = norm(part);
    const s = exactStation(k) ?? exactStation(k.replace(NOISE, " ").replace(/\s+/g, " ").trim());
    if (s) found.add(s);
    else if (k.replace(NOISE, "").trim()) return null;   // an unknown place in the field: refuse, do not guess
  }
  let hits = [...found];
  if (hits.length > 1) hits = hits.filter((h) => !hits.some((o) => DISTRICT_OF[o] === h));
  return hits.length === 1 ? hits[0] : null;
}

/** "Karachi, Lahore, ... and Adda Gamber" for messages. */
export const STATIONS_SENTENCE =
  STATIONS_ALL.slice(0, -1).join(", ") + " and " + STATIONS_ALL[STATIONS_ALL.length - 1];
