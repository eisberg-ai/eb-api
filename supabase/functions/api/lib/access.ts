import { admin } from "./env.ts";
import { isAdminUser } from "./auth.ts";

export type ProjectAccess = {
  project: { id: string; owner_user_id: string; workspace_id: string | null; is_public?: boolean } | null;
  isOwner: boolean;
  isWorkspaceMember: boolean;
  isAdmin: boolean;
};

async function isWorkspaceMember(workspaceId: string, userId: string): Promise<boolean> {
  const { data: workspace } = await admin
    .from("workspaces")
    .select("owner_user_id")
    .eq("id", workspaceId)
    .single();
  if (workspace?.owner_user_id === userId) return true;
  const { data: memberRows } = await admin
    .from("workspace_members")
    .select("user_id")
    .eq("workspace_id", workspaceId)
    .eq("user_id", userId)
    .eq("status", "active")
    .limit(1);
  return !!(memberRows && memberRows.length);
}

export async function getProjectAccess(projectId: string, userId: string): Promise<ProjectAccess> {
  const { data: project } = await admin
    .from("projects")
    .select("id, owner_user_id, workspace_id, is_public")
    .eq("id", projectId)
    .single();
  if (!project) {
    return { project: null, isOwner: false, isWorkspaceMember: false, isAdmin: false };
  }
  const isOwner = project.owner_user_id === userId;
  const isWorkspaceMemberFlag = !isOwner && project.workspace_id
    ? await isWorkspaceMember(project.workspace_id, userId)
    : false;
  const isAdmin = !isOwner && !isWorkspaceMemberFlag ? await isAdminUser(userId) : false;
  return {
    project,
    isOwner,
    isWorkspaceMember: isWorkspaceMemberFlag,
    isAdmin,
  };
}
