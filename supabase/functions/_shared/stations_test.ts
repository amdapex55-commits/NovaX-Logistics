// City names stores and merchants send (19 Oct 2026). Run:
//   deno test supabase/functions/_shared/stations_test.ts
import { assertEquals } from "jsr:@std/assert@1";
import { stationName } from "./stations.ts";

const cases: Array<[string, string | null]> = [
  ["Sahiwal, Punjab", "Sahiwal"], ["multan", "Multan"], ["Multan Punjab 60000", "Multan"],
  ["Okara District", "Okara"], ["Chichawatni, Sahiwal", "Chichawatni"], ["Adda Gamber, Okara", "Adda Gamber"],
  ["Lahore, Pakistan", "Lahore"], ["Yousaf Wala", "Yousuf Wala"], ["yousuf-wala", "Yousuf Wala"],
  ["Rawalpindi Cantt", "Rawalpindi"], ["Karachi.", "Karachi"], ["Islamabad, ICT", "Islamabad"],
  ["Faisal Abad", "Faisalabad"], ["Pindi", "Rawalpindi"], ["harrapa", "Harappa"],
  // never a guess
  ["Lahore, Multan", null], ["Gujranwala, Punjab", null], ["Lahore, Gujranwala", null],
  ["", null], ["Punjab", null], ["Multan Road, Lahore", null],
];
for (const [input, want] of cases) {
  Deno.test(`stationName(${JSON.stringify(input)}) -> ${want}`, () => assertEquals(stationName(input), want));
}
