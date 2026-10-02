// deno test supabase/functions/_shared/destination_test.ts
// Every reason unsafeDestination() refuses an address, with DNS stubbed.
import { assertEquals } from "jsr:@std/assert@1";
import { unsafeDestination } from "./destination.ts";

type Answers = Record<string, { A?: string[]; AAAA?: string[]; fail?: boolean }>;
function withDns(answers: Answers | null, fn: () => Promise<void>) {
  return async () => {
    const d = Deno as any, real = d.resolveDns;
    d.resolveDns = answers === null ? undefined : (host: string, t: "A" | "AAAA") => {
      const a = answers[host];
      if (!a || a.fail) return Promise.reject(new Error("dns"));
      return Promise.resolve(a[t] ?? []);
    };
    try { await fn(); } finally { d.resolveDns = real; }
  };
}
const ok = { "shop.example.com": { A: ["93.184.216.34"], AAAA: [] } };

Deno.test("public https name is allowed", withDns(ok, async () => {
  assertEquals(await unsafeDestination("https://shop.example.com/hook"), null);
}));
for (const [url, why] of [
  ["not a url", "invalid_url"],
  ["http://shop.example.com/hook", "not_https"],
  ["https://u:p@shop.example.com/hook", "credentials_in_url"],
  ["https://shop.example.com:8443/hook", "non_standard_port"],
  ["https://10.0.0.5/hook", "ip_address"],
  ["https://[::1]/hook", "ip_address"],
  ["https://localhost/hook", "private_host"],
  ["https://intranet/hook", "private_host"],
  ["https://db.internal/hook", "private_host"],
] as const) {
  Deno.test(`refuses ${why}: ${url}`, withDns(ok, async () => { assertEquals(await unsafeDestination(url), why); }));
}
Deno.test("refuses a name that resolves to a private v4 address", withDns({ "evil.example.com": { A: ["169.254.169.254"] } }, async () => {
  assertEquals(await unsafeDestination("https://evil.example.com/x"), "private_address");
}));
Deno.test("refuses a name that resolves to a private v6 address", withDns({ "evil6.example.com": { A: [], AAAA: ["fd00::1"] } }, async () => {
  assertEquals(await unsafeDestination("https://evil6.example.com/x"), "private_address");
}));
Deno.test("refuses when one family is public and the other private", withDns({ "mix.example.com": { A: ["93.184.216.34"], AAAA: ["::ffff:10.0.0.1"] } }, async () => {
  assertEquals(await unsafeDestination("https://mix.example.com/x"), "private_address");
}));
Deno.test("refuses when DNS fails (fails closed)", withDns({ "down.example.com": { fail: true } }, async () => {
  assertEquals(await unsafeDestination("https://down.example.com/x"), "dns_failed");
}));
Deno.test("refuses when the runtime cannot resolve at all", withDns(null, async () => {
  assertEquals(await unsafeDestination("https://shop.example.com/x"), "dns_unavailable");
}));
Deno.test("refuses a name with no addresses", withDns({ "empty.example.com": { A: [], AAAA: [] } }, async () => {
  assertEquals(await unsafeDestination("https://empty.example.com/x"), "unresolvable_host");
}));
