import { admin } from "./env.ts";
import { models } from "./registry.ts";

// draft: composer-only placeholder (attachments allowed, hidden from gallery); staged: created with no prompt/title, reused on next "new project";
// active: normal editable project; building: build in progress; failed: last build failed; archived: hidden/soft-deleted.
export const ALLOWED_PROJECT_STATUSES = ["draft", "staged", "active", "building", "failed", "archived"] as const;
export type ProjectStatus = (typeof ALLOWED_PROJECT_STATUSES)[number];

// default model for new projects
export const DEFAULT_MODEL: string = "claude-sonnet-4-5";
export const ALLOWED_MODELS: readonly string[] = models.map((model) => model.id);
const PRO_MODELS = new Set(models.filter((model) => model.isPro).map((model) => model.id));

export function validateModelStub(model?: string | null): string | null {
  if (!model || typeof model !== "string") return null;
  const trimmed = model.trim();
  if (!trimmed) return null;
  if (ALLOWED_MODELS.includes(trimmed)) return trimmed;
  return null;
}

export function isProModel(model?: string | null): boolean {
  if (!model || typeof model !== "string") return false;
  return PRO_MODELS.has(model.trim());
}

export function normalizeProjectStatus(status?: string | null): ProjectStatus | null {
  if (!status || typeof status !== "string") return null;
  const trimmed = status.trim();
  if (!trimmed) return null;
  return (ALLOWED_PROJECT_STATUSES as readonly string[]).includes(trimmed) ? (trimmed as ProjectStatus) : null;
}

export async function setProjectStatus(projectId: string, status: ProjectStatus) {
  await admin.from("projects").update({ status, updated_at: new Date().toISOString() }).eq("id", projectId);
}

/**
 * Get the user's current workspace from their profile, or fallback to first owned.
 */
export async function getCurrentWorkspaceId(userId: string): Promise<string | null> {
  // try profile first
  const { data: profile } = await admin
    .from("user_profiles")
    .select("current_workspace_id")
    .eq("user_id", userId)
    .single();
  if (profile?.current_workspace_id) return profile.current_workspace_id;
  // fallback to first owned workspace
  const { data: ws } = await admin
    .from("workspaces")
    .select("id")
    .eq("owner_user_id", userId)
    .limit(1)
    .single();
  return ws?.id ?? null;
}

export async function ensureProject(projectId: string, ownerUserId?: string) {
  const { data } = await admin.from("projects").select("id").eq("id", projectId).single();
  if (data) return;
  const owner = ownerUserId || "00000000-0000-0000-0000-000000000000";
  // get user's current workspace
  let workspaceId: string | null = null;
  if (ownerUserId) {
    workspaceId = await getCurrentWorkspaceId(ownerUserId);
  }
  let isPublic: boolean | undefined;
  if (ownerUserId) {
    const { data: subscription } = await admin
      .from("user_subscriptions")
      .select("plan_key")
      .eq("user_id", ownerUserId)
      .maybeSingle();
    const planKey = subscription?.plan_key ?? "free";
    isPublic = planKey === "free";
  }
  await admin.from("projects").insert({
    id: projectId,
    owner_user_id: owner,
    workspace_id: workspaceId,
    model: DEFAULT_MODEL,
    ...(isPublic !== undefined ? { is_public: isPublic } : {}),
  });
}
