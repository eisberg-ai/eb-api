import { json } from "../lib/response.ts";
import { admin } from "../lib/env.ts";
import { getUserOrService, getUserType, isAdminUser } from "../lib/auth.ts";
import { PLANS } from "../lib/plans.ts";

/**
 * Get user profile with workspace and credit info.
 */
async function handleGetProfile(req: Request) {
  const { user } = await getUserOrService(req);
  if (!user) return json({ error: "unauthorized" }, 401);
  // fetch profile
  const { data: profile } = await admin
    .from("user_profiles")
    .select("is_first_login, current_workspace_id, metadata, user_type, join_method, join_code, invites_total, invites_used, access_status, approved_at, approved_by, denied_at, denied_by")
    .eq("user_id", user.id)
    .single();
  // fetch current workspace details
  let currentWorkspace = null;
  if (profile?.current_workspace_id) {
    const { data: ws } = await admin
      .from("workspaces")
      .select("id, name, owner_user_id, created_at")
      .eq("id", profile.current_workspace_id)
      .single();
    currentWorkspace = ws;
  }
  // fetch credit balance
  const { data: balance } = await admin
    .from("credit_balances")
    .select("balance")
    .eq("user_id", user.id)
    .single();
  // fetch subscription
  const { data: sub } = await admin
    .from("user_subscriptions")
    .select("plan_key, status")
    .eq("user_id", user.id)
    .single();
  // get free credits amount from plans
  const freeCredits = PLANS.free.creditsMonthly;
  return json({
    isFirstLogin: profile?.is_first_login ?? false,
    currentWorkspaceId: profile?.current_workspace_id ?? null,
    currentWorkspace,
    creditBalance: balance?.balance ?? 0,
    planKey: sub?.plan_key ?? "free",
    freeCredits,
    userType: profile?.user_type ?? "user",
    metadata: profile?.metadata ?? {},
    joinMethod: profile?.join_method ?? null,
    joinCode: profile?.join_code ?? null,
    accessStatus: profile?.access_status ?? null,
    approvedAt: profile?.approved_at ?? null,
    approvedBy: profile?.approved_by ?? null,
    deniedAt: profile?.denied_at ?? null,
    deniedBy: profile?.denied_by ?? null,
    invitesTotal: profile?.invites_total ?? 5,
    invitesUsed: profile?.invites_used ?? 0,
    invitesRemaining: Math.max((profile?.invites_total ?? 5) - (profile?.invites_used ?? 0), 0),
  });
}

/**
 * Mark first login as complete (dismiss welcome modal).
 */
async function handleDismissWelcome(req: Request) {
  const { user } = await getUserOrService(req);
  if (!user) return json({ error: "unauthorized" }, 401);
  const { error } = await admin
    .from("user_profiles")
    .update({ is_first_login: false, updated_at: new Date().toISOString() })
    .eq("user_id", user.id);
  if (error) return json({ error: error.message }, 500);
  return json({ ok: true });
}

/**
 * Update current workspace.
 */
async function handleSetCurrentWorkspace(req: Request, body: any) {
  const { user } = await getUserOrService(req);
  if (!user) return json({ error: "unauthorized" }, 401);
  const workspaceId = body.workspaceId;
  if (!workspaceId) return json({ error: "workspaceId required" }, 400);
  // verify user has access to this workspace
  const { data: ws } = await admin
    .from("workspaces")
    .select("id, owner_user_id")
    .eq("id", workspaceId)
    .single();
  if (!ws) return json({ error: "workspace not found" }, 404);
  // check ownership or membership
  if (ws.owner_user_id !== user.id) {
    const { data: member } = await admin
      .from("workspace_members")
      .select("user_id")
      .eq("workspace_id", workspaceId)
      .eq("user_id", user.id)
      .eq("status", "active")
      .single();
    if (!member) return json({ error: "forbidden" }, 403);
  }
  // update profile
  const { error } = await admin
    .from("user_profiles")
    .upsert({
      user_id: user.id,
      current_workspace_id: workspaceId,
      updated_at: new Date().toISOString(),
    }, { onConflict: "user_id" });
  if (error) return json({ error: error.message }, 500);
  return json({ ok: true, currentWorkspaceId: workspaceId });
}

/**
 * Update profile metadata.
 */
async function handleUpdateProfile(req: Request, body: any) {
  const { user } = await getUserOrService(req);
  if (!user) return json({ error: "unauthorized" }, 401);
  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (body.metadata !== undefined) updates.metadata = body.metadata;
  if (body.currentWorkspaceId !== undefined) updates.current_workspace_id = body.currentWorkspaceId;
  const { error } = await admin
    .from("user_profiles")
    .upsert({ user_id: user.id, ...updates }, { onConflict: "user_id" });
  if (error) return json({ error: error.message }, 500);
  return json({ ok: true });
}

/**
 * Get onboarding status.
 */
async function handleGetOnboarding(req: Request) {
  const { user } = await getUserOrService(req);
  if (!user) return json({ error: "unauthorized" }, 401);
  const { data: profile } = await admin
    .from("user_profiles")
    .select("metadata")
    .eq("user_id", user.id)
    .single();
  const onboarding = (profile?.metadata as any)?.onboarding ?? null;
  return json({
    completed: onboarding?.completed === true,
    currentStep: onboarding?.currentStep ?? 0,
    answers: onboarding?.answers ?? {},
  });
}

/**
 * Submit onboarding progress (called per page).
 */
async function handleSubmitOnboarding(req: Request, body: any) {
  const { user } = await getUserOrService(req);
  if (!user) return json({ error: "unauthorized" }, 401);
  const { completed, currentStep, ...answers } = body;
  // fetch existing metadata
  const { data: profile } = await admin
    .from("user_profiles")
    .select("metadata")
    .eq("user_id", user.id)
    .single();
  const existingMetadata = (profile?.metadata as Record<string, unknown>) ?? {};
  const updatedMetadata = {
    ...existingMetadata,
    onboarding: {
      answers,
      currentStep: currentStep ?? 0,
      completed: completed === true,
      updatedAt: new Date().toISOString(),
    },
  };
  const { error } = await admin
    .from("user_profiles")
    .upsert({
      user_id: user.id,
      metadata: updatedMetadata,
      updated_at: new Date().toISOString(),
    }, { onConflict: "user_id" });
  if (error) return json({ error: error.message }, 500);
  return json({ ok: true });
}

async function handleSetUserType(req: Request, userId: string, body: any) {
  const { user, service } = await getUserOrService(req, { allowServiceKey: true });
  if (!service) {
    if (!user) return json({ error: "unauthorized" }, 401);
    const isAdmin = await isAdminUser(user.id);
    if (!isAdmin) return json({ error: "forbidden" }, 403);
  }
  const rawType = (body?.userType ?? body?.user_type ?? "").toString().toLowerCase();
  if (!rawType) return json({ error: "user_type_required" }, 400);
  const userType = rawType === "admin" ? "admin" : rawType === "user" ? "user" : null;
  if (!userType) return json({ error: "invalid_user_type" }, 400);
  const { error } = await admin
    .from("user_profiles")
    .upsert({
      user_id: userId,
      user_type: userType,
      updated_at: new Date().toISOString(),
    }, { onConflict: "user_id" });
  if (error) return json({ error: error.message }, 500);
  const updatedType = await getUserType(userId);
  return json({ ok: true, userId, userType: updatedType });
}

export async function handleUsers(req: Request, segments: string[], _url: URL, body: any) {
  const method = req.method.toUpperCase();
  if (segments[0] !== "users") return null;
  // GET /users/profile
  if (method === "GET" && segments[1] === "profile") {
    return handleGetProfile(req);
  }
  // POST /users/profile/dismiss-welcome
  if (method === "POST" && segments[1] === "profile" && segments[2] === "dismiss-welcome") {
    return handleDismissWelcome(req);
  }
  // POST /users/profile/current-workspace
  if (method === "POST" && segments[1] === "profile" && segments[2] === "current-workspace") {
    return handleSetCurrentWorkspace(req, body);
  }
  // PATCH /users/profile
  if (method === "PATCH" && segments[1] === "profile") {
    return handleUpdateProfile(req, body);
  }
  // GET /users/onboarding
  if (method === "GET" && segments[1] === "onboarding") {
    return handleGetOnboarding(req);
  }
  // POST /users/onboarding
  if (method === "POST" && segments[1] === "onboarding") {
    return handleSubmitOnboarding(req, body);
  }
  // POST /users/{id}/type
  if (method === "POST" && segments.length === 3 && segments[2] === "type" && segments[1] !== "profile") {
    return handleSetUserType(req, segments[1], body);
  }
  return null;
}



