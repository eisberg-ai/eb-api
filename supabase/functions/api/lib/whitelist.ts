// NOTE: we'll just update this as our whitelist grows
const WHITELIST = [
    "lkgwbr@gmail.com",
    "florian@brandartist.de",
    "vflexv@gmail.com"
];

export function canonicalizeEmail(email: string): string {
  const lower = email.trim().toLowerCase();
  const [local, domain] = lower.split("@");
  if (!local || !domain) return lower;
  if (domain === "gmail.com" || domain === "googlemail.com") {
    const noPlus = local.split("+")[0] || "";
    const noDots = noPlus.replace(/\./g, "");
    return `${noDots}@gmail.com`;
  }
  return `${local}@${domain}`;
}

type WhitelistSets = { raw: Set<string>; canonical: Set<string> };

export async function loadWhitelist(): Promise<WhitelistSets> {
  const envList = (Deno.env.get("WHITELIST_USERS") || "").trim();
  if (envList) {
    const entries = envList
      .split(/[\,\n]/)
      .map((l) => l.trim().toLowerCase())
      .filter((l) => l);
    const raw = new Set(entries);
    const canonical = new Set(entries.map(canonicalizeEmail));
    console.log("whitelist loaded from env", { count: canonical.size });
    return { raw, canonical };
  }
  const raw = new Set(WHITELIST.map((e) => e.toLowerCase()));
  const canonical = new Set([...raw].map(canonicalizeEmail));
  console.log("whitelist loaded from WHITELIST", { count: canonical.size });
  return { raw, canonical };
}

export { WHITELIST };
