import { json } from "../lib/response.ts";
import { getUserOrService } from "../lib/auth.ts";
import { admin } from "../lib/env.ts";
import { loadWhitelist, canonicalizeEmail } from "../lib/whitelist.ts";

async function handleGetWaitlist(req: Request) {
  const { user } = await getUserOrService(req);
  if (!user) return json({ error: "unauthorized" }, 401);
  const whitelist = await loadWhitelist();
  const email = (user.email || "").toLowerCase();
  const canonicalEmail = email ? canonicalizeEmail(email) : "";
  const hasEntries = whitelist.canonical.size > 0;
  let accessStatus: string | null = null;
  try {
    const { data: profile } = await admin
      .from("user_profiles")
      .select("access_status")
      .eq("user_id", user.id)
      .maybeSingle();
    accessStatus = profile?.access_status ?? null;
  } catch (err) {
    console.error("access status lookup failed", err);
  }
  if (accessStatus === "denied") {
    return json(
      {
        allowed: false,
        waitlisted: true,
        accessStatus,
        email,
        canonicalEmail,
        enforced: hasEntries,
        whitelistCount: whitelist.canonical.size,
      },
      403,
    );
  }
  let inviteCode: string | null = null;
  try {
    const { data: invite } = await admin
      .from("invite_codes")
      .select("code")
      .eq("redeemed_by", user.id)
      .maybeSingle();
    inviteCode = invite?.code ?? null;
  } catch (err) {
    console.error("invite lookup failed", err);
  }
  const allowedByWhitelist = hasEntries && canonicalEmail ? whitelist.canonical.has(canonicalEmail) : false;
  const allowedByApproval = accessStatus === "approved";
  const allowed = allowedByApproval || Boolean(inviteCode) || allowedByWhitelist;
  console.log("waitlist_check", {
    email,
    canonicalEmail,
    hasEntries,
    allowed,
    accessStatus,
    whitelistCount: whitelist.canonical.size,
    inviteCode,
    paths: {
      importPath: new URL("./whitelist.txt", import.meta.url).pathname,
      cwdPath: `${Deno.cwd()}/whitelist.txt`,
    },
  });

  if (allowed) {
    try {
      const { data: profile } = await admin
        .from("user_profiles")
        .select("join_method")
        .eq("user_id", user.id)
        .maybeSingle();
      const shouldUpdate = inviteCode
        ? profile?.join_method !== "invite"
        : allowedByWhitelist && !profile?.join_method;
      if (shouldUpdate) {
        const updates: Record<string, unknown> = { user_id: user.id, updated_at: new Date().toISOString() };
        if (inviteCode) {
          updates.join_method = "invite";
          updates.join_code = inviteCode;
        } else if (allowedByWhitelist) {
          updates.join_method = "waitlist";
        }
        await admin.from("user_profiles").upsert(updates, { onConflict: "user_id" });
      }
    } catch (err) {
      console.error("failed to update join method", err);
    }
  }

  if (!allowed) {
    return json(
      {
        allowed: false,
        waitlisted: true,
        accessStatus,
        email,
        canonicalEmail,
        enforced: hasEntries,
        whitelistCount: whitelist.canonical.size,
      },
      hasEntries ? 403 : 200,
    );
  }
  return json({
    allowed: true,
    waitlisted: false,
    accessStatus,
    email,
    canonicalEmail,
    inviteCode,
    enforced: hasEntries,
    whitelistCount: whitelist.canonical.size,
  });
}

export async function handleWaitlist(req: Request, segments: string[], _url: URL, _body: any) {
  if (segments[0] !== "auth" || segments[1] !== "waitlist") return null;
  return handleGetWaitlist(req);
}
