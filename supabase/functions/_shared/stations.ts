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

/** The station a whole city field names ("multan", "Yousaf Wala"), or null. */
export function stationName(raw: unknown): string | null {
  const k = String(raw ?? "").toLowerCase().replace(/[.,]/g, " ").replace(/\s+/g, " ").trim();
  if (!k) return null;
  return STATIONS_ALL.find((c) => c.toLowerCase() === k) ?? ALIASES[k] ?? null;
}

/** "Karachi, Lahore, ... and Adda Gamber" for messages. */
export const STATIONS_SENTENCE =
  STATIONS_ALL.slice(0, -1).join(", ") + " and " + STATIONS_ALL[STATIONS_ALL.length - 1];
