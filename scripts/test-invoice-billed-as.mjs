// An invoice row must say how the parcel was billed on THAT invoice, not how
// the parcel looks today. Uses the shape of a real case (INV-2610030d292):
// four parcels, one "Out of service area" when the invoice was made (billed
// as a return, charge only) and delivered two days later with COD 6,000.
// Runs the portal's own functions; touches no database.
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
const app = readFileSync(new URL("../client-app.js", import.meta.url), "utf8");
function fn(name){ const a=app.indexOf("    function "+name+"("); assert.ok(a>-1,"missing fn "+name); let i=app.indexOf("{",a),d=0; for(;i<app.length;i++){ if(app[i]==="{")d++; else if(app[i]==="}"){ d--; if(!d)break; } } return app.slice(a,i+1); }
const made="2026-10-03T18:52:25.172777+00:00";
const parcel=(awb,status,cod,deliveredAt,extra)=>Object.assign({ awb, status, cod, fee:180, deliveredAt, invoicedAt:made, paymentMode:"COD", city:"Karachi", consignee:"Test", date:"2026-10-02" }, extra||{});
const build=(parcels)=>new Function("parcels",
  "var window={}; var NV_STATUS_ALIASES={}; var state={parcels:parcels};"+
  "function escLabelText(v){return String(v==null?'':v);}"+
  ["nvStatus","isDeliveredLedgerParcel","isNonCodParcel","labelDate","nvInvoiceOutcome","nvInvoiceMadeMs","clientInvoiceLineItems"].map(fn).join("\n")+
  "; return clientInvoiceLineItems;")(parcels);
const ok=(m)=>console.log("ok - "+m);

// 1. The real case.
let parcels=[
  parcel("N3690125","Delivered",6000,"2026-10-05T14:27:10.105307+00:00"),
  parcel("N3690129","Delivered",2400,"2026-10-03T15:33:52.111115+00:00"),
  parcel("N3690130","Return to shipper",1500,null),
  parcel("N3690131","Delivered",0,"2026-10-03T14:10:00+00:00",{ paymentMode:"Non-COD" }),
];
let inv={ id:"INV-2610030d292", parcelRefs:parcels.map(p=>p.awb), cod:2400, charges:720, createdAt:"2026-10-03 23:52" };
let lines=build(parcels)(inv);
const late=lines.find(l=>l.awb==="N3690125");
assert.equal(late.outcome,"Billed as a return"); assert.equal(late.outcomeKey,"returned");
assert.equal(late.codAmount,0); assert.equal(late.laterCod,6000); assert.equal(late.collected,false);
assert.match(late.billedNote,/^Delivered 5 Oct, after this invoice was made\. COD 6000 is not included in this invoice\.$/);
ok("a parcel delivered after the invoice is shown as billed: a return, COD 0, with the later COD named");
assert.equal(lines.reduce((s,l)=>s+l.codAmount,0),2400);
ok("the rows now add up to the invoice's own COD total (2,400), not 8,400");
const normal=lines.find(l=>l.awb==="N3690129");
assert.equal(normal.outcome,"Delivered"); assert.equal(normal.codAmount,2400); assert.equal(normal.billedAsReturn,undefined);
ok("a parcel delivered before the invoice is untouched");
assert.equal(lines.find(l=>l.awb==="N3690130").outcome,"Returned");
ok("a returned parcel is untouched");

// 2. If the rule would not give the stored total, change nothing.
inv=Object.assign({},inv,{ cod:8400 });
lines=build(parcels)(inv);
assert.equal(lines.find(l=>l.awb==="N3690125").outcome,"Delivered");
assert.equal(lines.find(l=>l.awb==="N3690125").codAmount,6000);
assert.ok(!lines.some(l=>l.billedAsReturn));
ok("when the rule does not reproduce the stored total, the rows are left as they were");

// 3. No parcel moment: fall back to the invoice's Pakistan-time date.
parcels=[ parcel("N1","Delivered",900,"2026-10-03T19:30:00+00:00",{ invoicedAt:null }) ];   // 00:30 PKT on 4 Oct, 38 minutes after
lines=build(parcels)({ id:"X", parcelRefs:["N1"], cod:0, charges:180, createdAt:"2026-10-03 23:52" });
assert.equal(lines[0].billedAsReturn,true); assert.equal(lines[0].deliveredOn,"4 Oct");
ok("the invoice's own date is read as Pakistan time when the parcel has no invoiced moment");

// 4. Delivered a few seconds after (same run): not late.
parcels=[ parcel("N2","Delivered",700,"2026-10-03T18:52:40+00:00") ];
lines=build(parcels)({ id:"Y", parcelRefs:["N2"], cod:700, charges:180, createdAt:"2026-10-03 23:52" });
assert.equal(lines[0].outcome,"Delivered"); assert.equal(lines[0].codAmount,700);
ok("a delivery stamped seconds after the invoice is not treated as late");

// 5. The printed invoice and the export use the new fields.
assert.ok(app.includes("collected later &mdash; not on this invoice"));
assert.ok(app.includes("delivered after this invoice was made</b>"));
assert.ok(app.includes('"final_balance","note"]') && app.includes('inv.finalBalance||0,line.billedNote||""]'));
ok("the printed invoice explains it under the row and above the table; the export has a note column");
console.log("INVOICE BILLED-AS CHECKS PASSED");

// 6. Render the real printed invoice with those rows and read what it says.
{
  const parcels2=[
    parcel("N3690125","Delivered",6000,"2026-10-05T14:27:10.105307+00:00"),
    parcel("N3690129","Delivered",2400,"2026-10-03T15:33:52.111115+00:00"),
    parcel("N3690130","Return to shipper",1500,null),
    parcel("N3690131","Delivered",0,"2026-10-03T14:10:00+00:00",{ paymentMode:"Non-COD" }),
  ];
  const inv2={ id:"INV-2610030d292", clientId:"c1", parcelRefs:parcels2.map(p=>p.awb), cod:2400, charges:720, payable:1680, status:"Pushed to wallet", createdAt:"2026-10-03 23:52" };
  const real=["nvStatus","isDeliveredLedgerParcel","isNonCodParcel","labelDate","nvInvoiceOutcome","nvInvoiceMadeMs","clientInvoiceLineItems","clientInvoiceHtml"].map(fn).join("\n");
  const stubs={}; let html="";
  for(let i=0;i<40;i++){
    const pre="var window={}; var NV_STATUS_ALIASES={}; var state={parcels:parcels,invoices:[]};"+
      "function escLabelText(v){return String(v==null?'':v);} function labelText(v,f){return String(v==null||v===''?(f==null?'':f):v);}"+
      "function money(v){return 'Rs '+Number(v||0).toLocaleString('en-US');} function clientById(){return {name:'Test Store',city:'Karachi'};}"+
      Object.keys(stubs).map(n=>"function "+n+"(){return '';}").join("");
    try{ html=new Function("parcels","inv",pre+real+"; return clientInvoiceHtml(inv);")(parcels2,inv2); break; }
    catch(e){ const m=/^(\w+) is not defined/.exec(e.message); if(!(e instanceof ReferenceError)||!m) throw e; stubs[m[1]]=1; }
  }
  const text=html.replace(/<[^>]+>/g," ").replace(/&mdash;/g,"-").replace(/&middot;/g,"·").replace(/\s+/g," ");
  assert.match(text,/1 parcel was delivered after this invoice was made \(N3690125\)\. On this invoice it is billed as a return: delivery charge only\. The COD collected later, Rs 6,000 , is not part of this invoice\./);
  assert.match(text,/N3690125 .*Billed as a return delivered 5 Oct, after this invoice .*Rs 0 Rs 6,000 collected later - not on this invoice/);
  assert.match(text,/2 delivered · COD collected/); assert.match(text,/2 returned \/ refused · charge only/);
  assert.ok(!/differs from the invoice totals/.test(text),"the old 'rows differ from totals' note must be gone when the rows now add up");
  ok("printed invoice: the note, the row wording and the counts (2 delivered, 2 returned) all agree with the Rs 2,400 total");
}
console.log("INVOICE PRINT CHECK PASSED");
