// Where NovaX's servers may send a request on a merchant's behalf: a public
// https address on port 443, never loopback, link-local, private ranges or
// credentials in the URL. Copied from api-webhook-drain, which has run it
// since the Merchant API launched.
/* Destination guard. A merchant chooses the webhook URL and this function
   POSTs to it from inside our infrastructure, so without a check it can be
   pointed at loopback, link-local metadata endpoints or private ranges.
   Hostname rules always apply; the DNS rule runs when the runtime can
   resolve, so a public-looking name that points at a private address is
   refused too. */
export function privateV4(ip: string): boolean {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = p;
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) || a >= 224;
}
export function privateV6(ip: string): boolean {
  const s = ip.toLowerCase();
  return s === "::" || s === "::1" || /^f[cd]/.test(s) || /^fe[89ab]/.test(s) ||
    s.startsWith("::ffff:") || s.startsWith("64:ff9b");
}
export async function unsafeDestination(raw: string): Promise<string | null> {
  let u: URL;
  try { u = new URL(raw); } catch { return "invalid_url"; }
  if (u.protocol !== "https:") return "not_https";
  if (u.username || u.password) return "credentials_in_url";
  if (u.port && u.port !== "443") return "non_standard_port";
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host.includes(":") || /^[0-9.]+$/.test(host)) return "ip_address";
  if (!host.includes(".") || host === "localhost" ||
      /\.(localhost|local|internal|lan|home|corp|intranet)$/.test(host)) return "private_host";
  if (typeof (Deno as any).resolveDns !== "function") return null;
  let failures = 0;
  const look = (t: "A" | "AAAA") =>
    (Deno as any).resolveDns(host, t).catch(() => { failures++; return [] as string[]; });
  const [v4, v6] = await Promise.all([look("A"), look("AAAA")]);
  if ((v4 as string[]).some(privateV4) || (v6 as string[]).some(privateV6)) return "private_address";
  if (failures === 2) return null;   // resolver unavailable here; hostname rules above still held
  if (!(v4 as string[]).length && !(v6 as string[]).length) return "unresolvable_host";
  return null;
}
