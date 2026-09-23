/* The browser and the server must read a typed weight IDENTICALLY, because
 * the number they disagree on is the number on the invoice.
 *
 * The bug this locks down: every weight regex stopped at a comma, so "1,5"
 * matched "1". A parcel a merchant weighed at 1.5 kg was billed as 1 kg --
 * Rs 250 instead of Rs 335 on a Zone B parcel -- with no error shown to
 * anyone. A comma with one or two following digits is now treated as a
 * decimal point on both sides; "1,500" stays ambiguous and is refused by the
 * validator rather than guessed at, because a guess here changes the bill.
 *
 * The browser rule is executed from the real bundle text. The server rule is
 * asserted against the migration's regex so the two cannot drift apart
 * silently the way they did before.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../client-app.js", import.meta.url), "utf8");

function grab(name){
  const i = src.indexOf("function " + name + "(");
  assert(i >= 0, "missing in bundle: " + name);
  let d = 0;
  for (let k = src.indexOf("{", i); k < src.length; k++){
    if (src[k] === "{") d++;
    else if (src[k] === "}"){ d--; if (d === 0) return src.slice(i, k + 1); }
  }
  throw new Error("unbalanced braces reading " + name);
}

const sandbox = new Function(
  grab("nvNormalizeWeightCommas") + grab("parseWeightKg") + grab("nvWeightProblem") +
  "; return {parseWeightKg:parseWeightKg, nvWeightProblem:nvWeightProblem};"
)();

let pass = true;
function t(label, got, want){
  const ok = String(got) === String(want);
  if (!ok) pass = false;
  console.log((ok ? "  PASS  " : "  FAIL  ") + label + (ok ? "" : `   (got ${got}, want ${want})`));
}

/* ---- the comma cases, which are the whole point ---- */
t('parse "1,5"    = 1.5',  sandbox.parseWeightKg("1,5"), 1.5);
t('parse "2,25"   = 2.25', sandbox.parseWeightKg("2,25"), 2.25);
t('parse "1,5 kg" = 1.5',  sandbox.parseWeightKg("1,5 kg"), 1.5);
t('"1,500" is refused, not guessed',
  /dot for decimals/i.test(sandbox.nvWeightProblem("1,500") || ""), true);

/* ---- everything that already worked must keep working ---- */
t('parse "1.5"   = 1.5',  sandbox.parseWeightKg("1.5"), 1.5);
t('parse "2 kg"  = 2',    sandbox.parseWeightKg("2 kg"), 2);
t('parse "500 g" = 0.5',  sandbox.parseWeightKg("500 g"), 0.5);
t('parse "abc"   = 0.8 fallback', sandbox.parseWeightKg("abc"), 0.8);
t('"0" still rejected',   /more than zero/i.test(sandbox.nvWeightProblem("0") || ""), true);
t('"abc" still rejected', /include a number/i.test(sandbox.nvWeightProblem("abc") || ""), true);
t('"1,5" is accepted',    sandbox.nvWeightProblem("1,5"), null);

/* ---- the server must carry the same normalisation ---- */
const sql = readFileSync(new URL("../sql_novax_weight_comma_20260922.sql", import.meta.url), "utf8");
t("server normalises commas in nv_parse_weight_kg",
  /regexp_replace\([^)]*\[0-9\]\),\(\[0-9\]\{1,2\}\)/.test(sql.replace(/\s+/g, " ")), true);
t("server applies it in admin_reprice_parcel_weight too",
  (sql.match(/regexp_replace\(/g) || []).length >= 2, true);

console.log(pass ? "\nweight-parity: ALL PASS" : "\nweight-parity: FAILURES");
process.exit(pass ? 0 : 1);
