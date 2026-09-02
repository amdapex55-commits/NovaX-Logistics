/* NovaX — payment classification, server side.
 *
 * This is the SAME RULE as nv-payment.js in the repo root, which the browser
 * loads as a classic script. Deno cannot import a classic script and the
 * browser cannot import a Deno module, so the rule exists in two files.
 *
 * That duplication is dangerous, so it is checked rather than trusted:
 * scripts/check-build.mjs compares the prepaid pattern and the COD threshold in
 * both files and FAILS THE BUILD if they drift. If you change the rule here,
 * change it there too — the build will tell you if you forget.
 *
 * The rule, in one sentence: a parcel that says prepaid but carries a COD
 * amount above zero is neither prepaid nor COD, it is a conflict, and no code
 * downstream is allowed to resolve it silently.
 */

// KEEP IN SYNC: nv-payment.js PREPAID_RE
export const PREPAID_RE = /non\s*-?\s*cod|prepaid|^paid$/i;
// KEEP IN SYNC: nv-payment.js treats any cod > 0 as money on the parcel
export const COD_THRESHOLD = 0;

export type PaymentMode = "cod" | "prepaid" | "conflict";

export interface PaymentClass {
  mode: PaymentMode;
  conflict: boolean;
  cod: number;
  collectable: number;
  label: string;
  detail: string;
  declared: string;
}

function money(n: number): string {
  const v = Number(n || 0);
  return "Rs " + (isFinite(v) ? v : 0).toLocaleString("en-US");
}

export function classify(input: {
  cod?: unknown;
  cod_amount?: unknown;
  paymentMode?: unknown;
  payment_mode?: unknown;
}): PaymentClass {
  const declared = String(input?.paymentMode ?? input?.payment_mode ?? "").trim();
  const rawCod = input?.cod ?? input?.cod_amount ?? 0;
  let cod = Number(rawCod || 0);
  if (!isFinite(cod) || cod < 0) cod = 0;

  const saysPrepaid = PREPAID_RE.test(declared);

  if (saysPrepaid && cod > COD_THRESHOLD) {
    return {
      mode: "conflict",
      conflict: true,
      cod,
      /* Deliberately not zero — the amount is real and the parcel is in the
         field. Hiding it is how Rs 11,099 went unnoticed across 3 parcels. */
      collectable: cod,
      label: `COD ${money(cod)} but marked Prepaid`,
      detail:
        `This parcel is marked "${declared || "Prepaid"}" but carries a COD amount of ` +
        `${money(cod)}. Until someone decides whether the rider collects it, the money is ` +
        `neither invoiced nor expected in the rider's cash.`,
      declared: declared || "Prepaid",
    };
  }

  if (saysPrepaid) {
    return {
      mode: "prepaid", conflict: false, cod: 0, collectable: 0,
      label: "Prepaid", detail: "Already paid. The rider collects nothing.",
      declared,
    };
  }

  return {
    mode: "cod", conflict: false, cod, collectable: cod,
    label: "COD", detail: `The rider collects ${money(cod)} at the door.`,
    declared: declared || "COD",
  };
}

/** True when a merchant's submitted pair is self-contradictory. */
export function isConflict(codAmount: unknown, paymentMode: unknown): boolean {
  return classify({ cod_amount: codAmount, payment_mode: paymentMode }).mode === "conflict";
}
