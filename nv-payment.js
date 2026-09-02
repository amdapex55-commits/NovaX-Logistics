/* NovaX — payment classification. One function, used everywhere.
 *
 * Why this file exists: "is this parcel COD or prepaid?" was answered in five
 * places (client-app.js, admin.html twice, and both bulk validators), each with
 * its own regex. They agreed on the happy path and disagreed on the dangerous
 * one: a parcel carrying BOTH a COD amount and a prepaid marking.
 *
 * Every one of them resolved that silently in favour of prepaid, which means
 * the money vanished from the screen:
 *   - invoiceTotals() put it in the non-COD bucket, so the merchant was never
 *     shown the amount they are owed
 *   - the rider cash-in-hand sheet counted it as "prepaid", so the expected
 *     cash was short by exactly that amount
 * Nobody was told. On 2026-09-02 there were 3 such parcels worth Rs 11,099,
 * all live in the field, all from one merchant.
 *
 * The rule now: a declared-prepaid parcel with a COD amount above zero is not
 * prepaid and it is not COD. It is a CONFLICT, and a human has to resolve it.
 * Nothing downstream is allowed to guess.
 *
 * Loaded as a plain script by client.html, admin.html and rider.html; there is
 * no bundler in this repo, so it attaches to window and is safe to load twice.
 */
(function (global) {
  "use strict";
  if (global.NovaXPayment) return;

  /* "Non COD Prepaid" is the value the bulk template and the API both use.
     "paid" is included because merchants type it; "non-cod" and "non cod"
     because both appear in live data. */
  var PREPAID_RE = /non\s*-?\s*cod|prepaid|^paid$/i;

  function money(n) {
    var v = Number(n || 0);
    if (!isFinite(v)) v = 0;
    return "Rs " + v.toLocaleString("en-US");
  }

  function codOf(parcel) {
    if (!parcel) return 0;
    var raw = parcel.cod;
    if (raw === undefined || raw === null) raw = parcel.cod_amount;
    var v = Number(raw || 0);
    return isFinite(v) && v > 0 ? v : 0;
  }

  function declaredOf(parcel) {
    if (!parcel) return "";
    return String(parcel.paymentMode || parcel.payment_mode || "").trim();
  }

  /**
   * classify(parcel) -> {
   *   mode:        "cod" | "prepaid" | "conflict"
   *   conflict:    boolean
   *   cod:         number  — the amount on the parcel, never zeroed out
   *   collectable: number  — what the rider should collect; 0 only for real prepaid
   *   label:       string  — short human label for a chip
   *   detail:      string  — the full sentence, for a warning or a tooltip
   *   declared:    string  — the raw payment mode as stored
   * }
   */
  function classify(parcel) {
    var declared = declaredOf(parcel);
    var cod = codOf(parcel);
    var saysPrepaid = PREPAID_RE.test(declared);

    if (saysPrepaid && cod > 0) {
      return {
        mode: "conflict",
        conflict: true,
        cod: cod,
        /* Deliberately NOT zero. The amount is real and the parcel is in the
           field; hiding it is how this went unnoticed in the first place. */
        collectable: cod,
        label: "COD " + money(cod) + " but marked Prepaid",
        detail: "This parcel is marked “" + (declared || "Prepaid") + "” but carries a COD " +
                "amount of " + money(cod) + ". Until someone decides whether the rider collects it, " +
                "the money is neither invoiced nor expected in the rider’s cash.",
        declared: declared || "Prepaid"
      };
    }

    if (saysPrepaid) {
      return {
        mode: "prepaid", conflict: false, cod: 0, collectable: 0,
        label: "Prepaid", detail: "Already paid. The rider collects nothing.",
        declared: declared
      };
    }

    return {
      mode: "cod", conflict: false, cod: cod, collectable: cod,
      label: "COD", detail: "The rider collects " + money(cod) + " at the door.",
      declared: declared || "COD"
    };
  }

  function isConflict(parcel) { return classify(parcel).mode === "conflict"; }

  /* Replaces the old isNonCodParcel(). A conflicted parcel is deliberately NOT
     treated as prepaid — that is the whole point — so money keeps counting
     until a human resolves it. */
  function isPrepaid(parcel) { return classify(parcel).mode === "prepaid"; }

  /* What the rider is expected to collect. Conflicts still count, so the cash
     sheet cannot silently come up short. */
  function collectable(parcel) { return classify(parcel).collectable; }

  function conflicts(parcels) {
    return (parcels || []).filter(isConflict);
  }

  /* One place that decides whether a batch may be processed. */
  function batchBlock(parcels) {
    var bad = conflicts(parcels);
    if (!bad.length) return null;
    var total = bad.reduce(function (s, p) { return s + codOf(p); }, 0);
    return {
      blocked: true,
      count: bad.length,
      total: total,
      awbs: bad.map(function (p) { return p.awb; }),
      message: bad.length + " parcel" + (bad.length === 1 ? "" : "s") +
               " in this batch carry a COD amount but are marked Prepaid (" + money(total) + " total). " +
               "Resolve the payment conflict before processing, or the rider’s cash will not reconcile."
    };
  }

  global.NovaXPayment = {
    classify: classify,
    isConflict: isConflict,
    isPrepaid: isPrepaid,
    collectable: collectable,
    conflicts: conflicts,
    batchBlock: batchBlock,
    money: money,
    PREPAID_RE: PREPAID_RE
  };
})(typeof window !== "undefined" ? window : globalThis);
