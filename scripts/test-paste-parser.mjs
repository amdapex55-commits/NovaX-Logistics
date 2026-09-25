#!/usr/bin/env node
/* Paste-to-book parser regression test.
   The form's own placeholder once booked "black hoodie DHA Phase 5 house 22"
   as the delivery address and left the product blank. Every case here must
   keep passing; the first two are the examples shown to merchants. */
import { readFileSync } from "node:fs";
const s = readFileSync(new URL("../client-app.js", import.meta.url), "utf8");
function grab(n){ const i=s.indexOf("function "+n+"("); if(i<0) throw new Error("missing "+n); let d=0; for(let k=s.indexOf("{",i);k<s.length;k++){ if(s[k]==="{")d++; else if(s[k]==="}"){ d--; if(!d) return s.slice(i,k+1); } } }
const a=s.indexOf("var NV_ADDR_START=");
const parse=(0,eval)("(function(){"+grab("nvNormalizePkPhone")+";var NV_CITY_LIST=['lahore','karachi','islamabad','rawalpindi'];"+grab("nvFindCity")+";"+s.slice(a,s.indexOf("\n",a))+";"+grab("prodLabelEarly")+";"+grab("nvAddrStartTok")+";"+grab("nvPasteRemainder")+";"+grab("parsePastedOrder")+";return parsePastedOrder;})()");
const placeholder=(readFileSync(new URL("../client.html", import.meta.url),"utf8").match(/id="nvPasteInput"[^>]*placeholder="e\.g\. ([^"]+)"/)||[])[1];
const cases=[
 {
  "in": "Ali Khan 03123456789 Lahore COD 2500 black hoodie DHA Phase 5 house 22",
  "want": {
   "name": "Ali Khan",
   "phone": "03123456789",
   "city": "Lahore",
   "cod": "2500",
   "product": "black hoodie",
   "address": "DHA Phase 5 house 22"
  }
 },
 {
  "in": "Hina Raza 03001234567 Karachi COD 2400 black abaya size M, House 14 Block 5 Gulshan-e-Iqbal",
  "want": {
   "name": "Hina Raza",
   "phone": "03001234567",
   "city": "Karachi",
   "cod": "2400",
   "product": "black abaya size M",
   "address": "House 14 Block 5 Gulshan-e-Iqbal"
  }
 },
 {
  "in": "Name: Hina Raza\nPhone: 0311 332 3923\nCity: Karachi\nAddress: House 5, DHA Phase 5\nProduct: Lawn suit\nCOD: 3200",
  "want": {
   "name": "Hina Raza",
   "phone": "03113323923",
   "city": "Karachi",
   "cod": "3200",
   "product": "Lawn suit",
   "address": "House 5, DHA Phase 5"
  }
 },
 {
  "in": "Ali Raza 03113323923 844 f2 Johar Town Lahore COD 1800",
  "want": {
   "name": "Ali Raza",
   "phone": "03113323923",
   "city": "Lahore",
   "cod": "1800",
   "address": "844 f2 Johar Town"
  }
 },
 {
  "in": "Sana 0300-1234567 Islamabad cod 0 sector G-11/2 street 4 house 9 perfume",
  "want": {
   "phone": "03001234567",
   "city": "Islamabad",
   "cod": "0",
   "address": "sector G-11/2 street 4 house 9",
   "product": "perfume",
   "name": "Sana"
  }
 },
 {
  "in": "Usman Tariq 0321-5550011 Karachi COD 1200 2 lawn suits, Flat 3B, Block 7, Gulistan-e-Johar",
  "want": {
   "name": "Usman Tariq",
   "phone": "03215550011",
   "city": "Karachi",
   "cod": "1200",
   "product": "2 lawn suits",
   "address": "Flat 3B, Block 7, Gulistan-e-Johar"
  }
 },
 {
  "in": "Maryam Khan\n03455556677\nLahore\nCOD 4300\nHouse 12, Street 5, Model Town\nRed kurta",
  "want": {
   "name": "Maryam Khan",
   "phone": "03455556677",
   "city": "Lahore",
   "cod": "4300",
   "address": "House 12, Street 5, Model Town",
   "product": "Red kurta"
  }
 },
 {
  "in": "Bilal +923001112233 Rawalpindi Rs 1500 perfume set Bahria Town phase 7 house 41",
  "want": {
   "phone": "03001112233",
   "city": "Rawalpindi",
   "cod": "1500",
   "product": "perfume set",
   "address": "Bahria Town phase 7 house 41"
  }
 },
 {
  "in": "Name: Ayesha\nPhone: 03331234567\nAddress: House 5, DHA Phase 6, Karachi\nCOD: 900",
  "want": {
   "name": "Ayesha",
   "phone": "03331234567",
   "cod": "900",
   "address": "House 5, DHA Phase 6, Karachi"
  }
 }
];
if(placeholder) cases.unshift({in:placeholder,want:{product:"black hoodie",address:"DHA Phase 5 house 22"}});
let fail=0;
for(const c of cases){ const o=parse(c.in); for(const k of Object.keys(c.want)){ if(o[k]!==c.want[k]){ fail++; console.log("FAIL",JSON.stringify(c.in.slice(0,60)),k,"got",JSON.stringify(o[k]),"want",JSON.stringify(c.want[k])); } } }
if(fail){ console.log("paste-parser: "+fail+" failing"); process.exit(1); }
console.log("paste-parser: ALL PASS ("+cases.length+" pastes)");
