import { json } from "../lib/response.ts";
import { admin } from "../lib/env.ts";
import { getUserOrService } from "../lib/auth.ts";

async function isWorkspaceMember(workspaceId: string, userId: string): Promise<boolean> {
  const { data: ws } = await admin.from("workspaces").select("owner_user_id").eq("id", workspaceId).single();
  if (ws?.owner_user_id === userId) return true;
  const { data: memberRows } = await admin
    .from("workspace_members")
    .select("user_id")
    .eq("workspace_id", workspaceId)
    .eq("user_id", userId)
    .eq("status", "active")
    .limit(1);
  return !!(memberRows && memberRows.length);
}

async function handleGetWorkspaces(req: Request) {
  const { user } = await getUserOrService(req);
  if (!user) return json({ error: "unauthorized" }, 401);
  const { data: owned } = await admin.from("workspaces").select("*").eq("owner_user_id", user.id);
  const { data: memberRows } = await admin
    .from("workspace_members")
    .select("workspace_id")
    .eq("user_id", user.id)
    .eq("status", "active");
  const memberIds = (memberRows ?? []).map((r: any) => r.workspace_id).filter(Boolean);
  const { data: memberWorkspaces } = memberIds.length
    ? await admin.from("workspaces").select("*").in("id", memberIds)
    : { data: [] };
  const all = [...(owned ?? []), ...(memberWorkspaces ?? [])];
  const unique = Array.from(new Map(all.map((w: any) => [w.id, w])).values());
  return json({ workspaces: unique });
}

async function handleGetWorkspace(req: Request, workspaceId: string) {
  const { user } = await getUserOrService(req);
  if (!user) return json({ error: "unauthorized" }, 401);
  const member = await isWorkspaceMember(workspaceId, user.id);
  if (!member) return json({ error: "forbidden" }, 403);
  const { data, error } = await admin.from("workspaces").select("*").eq("id", workspaceId).single();
  if (error || !data) return json({ error: "not found" }, 404);
  return json({ workspace: data });
}

async function handlePatchWorkspace(req: Request, workspaceId: string, body: any) {
  const { user } = await getUserOrService(req);
  if (!user) return json({ error: "unauthorized" }, 401);
  const { data: workspace } = await admin.from("workspaces").select("owner_user_id").eq("id", workspaceId).single();
  if (!workspace) return json({ error: "not found" }, 404);
  if (workspace.owner_user_id !== user.id) {
    const { data: member } = await admin
      .from("workspace_members")
      .select("role")
      .eq("workspace_id", workspaceId)
      .eq("user_id", user.id)
      .eq("status", "active")
      .single();
    if (member?.role !== "admin") return json({ error: "forbidden" }, 403);
  }
  const updates: any = {};
  if (body.name !== undefined) updates.name = body.name;
  if (body.slug !== undefined) updates.slug = body.slug;
  if (Object.keys(updates).length === 0) return json({ error: "no updates provided" }, 400);
  updates.updated_at = new Date().toISOString();
  const { data, error } = await admin.from("workspaces").update(updates).eq("id", workspaceId).select("*").single();
  if (error) return json({ error: error.message }, 500);
  return json({ workspace: data });
}

async function handleDeleteWorkspace(req: Request, workspaceId: string) {
  const { user } = await getUserOrService(req);
  if (!user) return json({ error: "unauthorized" }, 401);
  const { data: workspace } = await admin.from("workspaces").select("owner_user_id").eq("id", workspaceId).single();
  if (!workspace) return json({ error: "not found" }, 404);
  if (workspace.owner_user_id !== user.id) return json({ error: "forbidden" }, 403);
  const { error } = await admin.from("workspaces").delete().eq("id", workspaceId);
  if (error) return json({ error: error.message }, 500);
  return json({ ok: true });
}

async function handlePostWorkspaces(req: Request, body: any) {
  const { user } = await getUserOrService(req);
  if (!user) return json({ error: "unauthorized" }, 401);
  const name = (body?.name ?? "").toString().trim();
  if (!name) return json({ error: "name required" }, 400);
  const workspaceId = body.id || crypto.randomUUID();
  const slug = body.slug || null;
  const { data, error } = await admin
    .from("workspaces")
    .insert({ id: workspaceId, name, slug, owner_user_id: user.id })
    .select("*")
    .single();
  if (error || !data) return json({ error: error?.message || "failed to create workspace" }, 500);
  await admin.from("workspace_members").upsert({
    workspace_id: workspaceId,
    user_id: user.id,
    role: "owner",
    status: "active",
  });
  return json({ workspace: data });
}

async function handleGetWorkspaceMembers(req: Request, workspaceId: string) {
  const { user } = await getUserOrService(req);
  if (!user) return json({ error: "unauthorized" }, 401);
  const member = await isWorkspaceMember(workspaceId, user.id);
  if (!member) return json({ error: "forbidden" }, 403);
  const { data: members, error } = await admin
    .from("workspace_members")
    .select("user_id, role, status, created_at")
    .eq("workspace_id", workspaceId);
  if (error) return json({ error: error.message }, 500);
  // fetch user emails from auth.users
  const memberData = await Promise.all(
    (members ?? []).map(async (m: any) => {
      const { data: userData } = await admin.auth.admin.getUserById(m.user_id);
      return {
        ...m,
        email: userData?.user?.email ?? null,
        name: userData?.user?.user_metadata?.name ?? null,
      };
    })
  );
  return json({ members: memberData });
}

async function handlePostWorkspaceMembers(req: Request, workspaceId: string, body: any) {
  const { user } = await getUserOrService(req);
  if (!user) return json({ error: "unauthorized" }, 401);
  const member = await isWorkspaceMember(workspaceId, user.id);
  if (!member) return json({ error: "forbidden" }, 403);
  const { data: workspace } = await admin.from("workspaces").select("is_private").eq("id", workspaceId).single();
  if (workspace?.is_private) return json({ error: "forbidden" }, 403);
  const payload = body || {};
  if (!payload.userId) return json({ error: "userId required" }, 400);
  const { error } = await admin.from("workspace_members").upsert({
    workspace_id: workspaceId,
    user_id: payload.userId,
    role: payload.role ?? "editor",
    status: payload.status ?? "active",
  });
  if (error) return json({ error: error.message }, 500);
  return json({ ok: true });
}

async function handleDeleteWorkspaceMember(req: Request, workspaceId: string, memberUserId: string) {
  const { user } = await getUserOrService(req);
  if (!user) return json({ error: "unauthorized" }, 401);
  const { data: ws } = await admin.from("workspaces").select("owner_user_id").eq("id", workspaceId).single();
  if (ws?.owner_user_id !== user.id) return json({ error: "forbidden" }, 403);
  const { error } = await admin
    .from("workspace_members")
    .delete()
    .eq("workspace_id", workspaceId)
    .eq("user_id", memberUserId);
  if (error) return json({ error: error.message }, 500);
  return json({ ok: true });
}

export async function handleWorkspaces(req: Request, segments: string[], _url: URL, body: any) {
  const method = req.method.toUpperCase();
  if (segments[0] !== "workspaces") return null;
  // GET /workspaces
  if (method === "GET" && segments.length === 1) {
    return handleGetWorkspaces(req);
  }
  // POST /workspaces
  if (method === "POST" && segments.length === 1) {
    return handlePostWorkspaces(req, body);
  }
  // GET /workspaces/{id}
  if (method === "GET" && segments.length === 2) {
    return handleGetWorkspace(req, segments[1]);
  }
  // PATCH /workspaces/{id}
  if (method === "PATCH" && segments.length === 2) {
    return handlePatchWorkspace(req, segments[1], body);
  }
  // DELETE /workspaces/{id}
  if (method === "DELETE" && segments.length === 2) {
    return handleDeleteWorkspace(req, segments[1]);
  }
  // GET /workspaces/{id}/members
  if (method === "GET" && segments.length === 3 && segments[2] === "members") {
    return handleGetWorkspaceMembers(req, segments[1]);
  }
  // POST /workspaces/{id}/members
  if (method === "POST" && segments.length === 3 && segments[2] === "members") {
    return handlePostWorkspaceMembers(req, segments[1], body);
  }
  // DELETE /workspaces/{id}/members/{userId}
  if (method === "DELETE" && segments.length === 4 && segments[2] === "members") {
    return handleDeleteWorkspaceMember(req, segments[1], segments[3]);
  }
  return null;
}
