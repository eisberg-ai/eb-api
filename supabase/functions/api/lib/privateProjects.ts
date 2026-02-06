import { admin } from "./env.ts";

export const PRIVATE_EXPIRY_DAYS = 30;

export function computePrivateExpiryAt(base?: Date): string {
  const start = base ?? new Date();
  const expiry = new Date(start.getTime() + PRIVATE_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
  return expiry.toISOString();
}

export async function markPrivateProjectsPendingExpiry(userId: string, expiryAt: string) {
  const { data: projects, error: listError } = await admin
    .from("projects")
    .select("id, private_expiry_at")
    .eq("owner_user_id", userId)
    .eq("is_public", false);
  if (listError) {
    throw new Error(listError.message);
  }
  const privateProjects = projects ?? [];
  const newlyMarkable = privateProjects.filter((p: any) => !p.private_expiry_at).map((p: any) => p.id);
  if (newlyMarkable.length > 0) {
    const { error: updateError } = await admin
      .from("projects")
      .update({
        private_pending_expiry: true,
        private_expiry_at: expiryAt,
        updated_at: new Date().toISOString(),
      })
      .in("id", newlyMarkable);
    if (updateError) {
      throw new Error(updateError.message);
    }
  }
  return {
    totalPrivate: privateProjects.length,
    newlyMarked: newlyMarkable.length,
  };
}

export async function clearPrivateExpiryForUser(userId: string) {
  const { error } = await admin
    .from("projects")
    .update({
      private_pending_expiry: false,
      private_expiry_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq("owner_user_id", userId);
  if (error) {
    throw new Error(error.message);
  }
}

export async function clearPrivateExpiryForProject(projectId: string) {
  const { error } = await admin
    .from("projects")
    .update({
      private_pending_expiry: false,
      private_expiry_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", projectId);
  if (error) {
    throw new Error(error.message);
  }
}
