import { json } from "../lib/response.ts";
import { admin } from "../lib/env.ts";
import { getUserOrService, isAdminUser } from "../lib/auth.ts";
import { generateCode, normalizeCode } from "../lib/codes.ts";

type InviteCodeRow = {
  code: string;
  max_uses: number;
  uses_count: number;
  redeemed_at?: string | null;
  created_by?: string | null;
  created_by_role?: string | null;
};

async function generateUniqueInviteCode(payload: Record<string, unknown>) {
  const maxAttempts = 5;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const code = generateCode(8);
    const { data, error } = await admin
      .from("invite_codes")
      .insert({ code, ...payload })
      .select("code,created_at")
      .single();
    if (!error && data) return data;
    if (error && (error as any).code !== "23505") {
      console.error("invite create failed", error);
      throw new Error("invite_create_failed");
    }
  }
  throw new Error("invite_create_failed");
}

async function handleRedeemInvite(req: Request, body: any) {
  const { user } = await getUserOrService(req);
  if (!user) return json({ error: "unauthorized" }, 401);
  const rawCode = (body?.code ?? body?.inviteCode ?? body?.invite_code ?? "").toString();
  const code = normalizeCode(rawCode);
  if (!code) return json({ error: "invite_code_required" }, 400);

  // Admin bypass: OGWIGGAS always works for admin users
  if (code === "OGWIGGAS") {
    const isAdmin = await isAdminUser(user.id);
    if (isAdmin) {
      const now = new Date().toISOString();
      try {
        await admin.from("user_profiles").upsert({
          user_id: user.id,
          join_method: "invite",
          join_code: code,
          updated_at: now,
        }, { onConflict: "user_id" });
      } catch (err) {
        console.error("failed to update join method", err);
      }
      return json({ ok: true, code, redeemedAt: now, inviterUserId: null, inviterRole: "admin" });
    }
  }

  const { data: invite, error } = await admin
    .from("invite_codes")
    .select("code,max_uses,uses_count,redeemed_at,created_by,created_by_role")
    .eq("code", code)
    .maybeSingle();
  if (error) {
    console.error("invite lookup failed", error);
    return json({ error: "invite_lookup_failed" }, 500);
  }
  if (!invite) return json({ error: "invalid_invite_code" }, 400);
  const inviteRow = invite as InviteCodeRow;
  const currentUses = Number(inviteRow.uses_count ?? 0);
  const maxUses = Number(inviteRow.max_uses ?? 1);
  if (inviteRow.redeemed_at || currentUses >= maxUses) {
    return json({ error: "invite_code_used" }, 409);
  }

  const now = new Date().toISOString();
  const redeemedEmail = user.email?.toLowerCase() ?? null;
  const { data: claimed, error: claimError } = await admin
    .from("invite_codes")
    .update({
      uses_count: currentUses + 1,
      redeemed_by: user.id,
      redeemed_email: redeemedEmail,
      redeemed_at: now,
      updated_at: now,
    })
    .eq("code", code)
    .is("redeemed_at", null)
    .select("code,created_by,created_by_role")
    .maybeSingle();
  if (claimError) {
    console.error("invite claim failed", claimError);
    return json({ error: "invite_redeem_failed" }, 500);
  }
  if (!claimed) return json({ error: "invite_code_used" }, 409);

  try {
    await admin.from("user_profiles").upsert({
      user_id: user.id,
      join_method: "invite",
      join_code: code,
      updated_at: now,
    }, { onConflict: "user_id" });
  } catch (err) {
    console.error("failed to update join method", err);
  }

  return json({
    ok: true,
    code,
    redeemedAt: now,
    inviterUserId: (claimed as any)?.created_by ?? inviteRow.created_by ?? null,
    inviterRole: (claimed as any)?.created_by_role ?? inviteRow.created_by_role ?? null,
  });
}

async function handleCreateInvite(req: Request) {
  const { user } = await getUserOrService(req);
  if (!user) return json({ error: "unauthorized" }, 401);

  const { data: profile } = await admin
    .from("user_profiles")
    .select("invites_total,invites_used,user_type")
    .eq("user_id", user.id)
    .maybeSingle();

  const invitesTotal = Number(profile?.invites_total ?? 5);
  const invitesUsed = Number(profile?.invites_used ?? 0);
  const userType = (profile?.user_type ?? "user").toString();
  const isAdmin = userType === "admin" || await isAdminUser(user.id);

  if (!isAdmin && invitesUsed >= invitesTotal) {
    return json({ error: "invite_quota_exceeded", invitesTotal, invitesUsed }, 409);
  }

  const now = new Date().toISOString();
  const payload = {
    created_by: user.id,
    created_by_role: isAdmin ? "admin" : "user",
    created_by_email: user.email?.toLowerCase() ?? null,
    created_at: now,
    updated_at: now,
    max_uses: 1,
    uses_count: 0,
  };

  try {
    const data = await generateUniqueInviteCode(payload);
    if (!isAdmin) {
      await admin.from("user_profiles").upsert({
        user_id: user.id,
        invites_used: invitesUsed + 1,
        updated_at: now,
      }, { onConflict: "user_id" });
    }
    return json({
      code: data.code,
      createdAt: data.created_at ?? now,
      invitesTotal,
      invitesUsed: isAdmin ? invitesUsed : invitesUsed + 1,
      invitesRemaining: isAdmin ? null : Math.max(invitesTotal - (invitesUsed + 1), 0),
    });
  } catch (err: any) {
    return json({ error: err?.message ?? "invite_create_failed" }, 500);
  }
}

async function handleListInvites(req: Request, url: URL) {
  const { user } = await getUserOrService(req);
  if (!user) return json({ error: "unauthorized" }, 401);
  const limitRaw = Number(url.searchParams.get("limit") ?? 20);
  const offsetRaw = Number(url.searchParams.get("offset") ?? 0);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 100) : 20;
  const offset = Number.isFinite(offsetRaw) ? Math.max(offsetRaw, 0) : 0;

  const { data, error, count } = await admin
    .from("invite_codes")
    .select("code,created_at,redeemed_at,redeemed_by,redeemed_email,uses_count,max_uses", { count: "exact" })
    .eq("created_by", user.id)
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) return json({ error: error.message }, 500);

  const { data: profile } = await admin
    .from("user_profiles")
    .select("invites_total,invites_used")
    .eq("user_id", user.id)
    .maybeSingle();
  const invitesTotal = Number(profile?.invites_total ?? 5);
  const invitesUsed = Number(profile?.invites_used ?? 0);

  return json({
    rows: data ?? [],
    total: count ?? 0,
    invitesTotal,
    invitesUsed,
    invitesRemaining: Math.max(invitesTotal - invitesUsed, 0),
  });
}

export async function handleInvites(req: Request, segments: string[], url: URL, body: any) {
  const method = req.method.toUpperCase();
  if (segments[0] === "auth" && segments[1] === "invite" && method === "POST") {
    return handleRedeemInvite(req, body);
  }
  if (segments[0] !== "invites") return null;
  if (method === "POST") return handleCreateInvite(req);
  if (method === "GET") return handleListInvites(req, url);
  return null;
}
