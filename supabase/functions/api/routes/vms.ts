import { admin } from "../lib/env.ts";
import { getUserOrService } from "../lib/auth.ts";
import { getProjectAccess } from "../lib/access.ts";
import { json } from "../lib/response.ts";
import { startVm } from "../lib/vm.ts";

async function handleGetVm(req: Request, projectId: string) {
  const { user, service } = await getUserOrService(req, { allowServiceKey: true });
  if (!user && !service) return json({ error: "unauthorized" }, 401);
  if (user) {
    const access = await getProjectAccess(projectId, user.id);
    if (!access.project) return json({ error: "not found" }, 404);
    if (!access.isOwner && !access.isWorkspaceMember && !access.isAdmin) {
      return json({ error: "forbidden" }, 403);
    }
  }
  const { data, error } = await admin
    .from("vms")
    .select("*")
    .eq("project_id", projectId)
    .maybeSingle();
  if (error) return json({ error: error.message }, 500);
  if (!data) return json({ error: "not found" }, 404);
  return json({ vm: data });
}

async function handlePostVmHeartbeat(req: Request, projectId: string, body: any) {
  const { service } = await getUserOrService(req, { allowServiceKey: true });
  if (!service) return json({ error: "unauthorized" }, 401);
  const updates: Record<string, unknown> = {
    last_heartbeat_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  if (body?.runtime_state) updates.runtime_state = body.runtime_state;
  if (body?.lease_owner !== undefined) updates.lease_owner = body.lease_owner;
  if (body?.lease_expires_at !== undefined) updates.lease_expires_at = body.lease_expires_at;
  if (body?.last_shutdown_at !== undefined) updates.last_shutdown_at = body.last_shutdown_at;
  if (body?.current_source_tar_gz !== undefined) updates.current_source_tar_gz = body.current_source_tar_gz;
  const { error } = await admin.from("vms").update(updates).eq("project_id", projectId);
  if (error) return json({ error: error.message }, 500);
  return json({ ok: true });
}

async function handleRegisterVm(req: Request, body: any) {
  const { service } = await getUserOrService(req, { allowServiceKey: true });
  console.info("[vms/register] received", { body, hasService: !!service });
  if (!service) return json({ error: "unauthorized" }, 401);
  const instanceId = body?.instance_id || body?.instanceId;
  const baseUrl = body?.base_url || body?.baseUrl;
  console.info("[vms/register] parsed", { instanceId, baseUrl });
  if (!instanceId || !baseUrl) return json({ error: "missing_instance_id_or_base_url" }, 400);

  // Try to verify the worker is reachable (non-blocking, just for debugging)
  try {
    const healthUrl = `${baseUrl}/health`;
    console.info("[vms/register] checking health", { healthUrl });
    const healthResp = await fetch(healthUrl, { method: "GET", signal: AbortSignal.timeout(3000) });
    console.info("[vms/register] health check result", { status: healthResp.status, ok: healthResp.ok });
  } catch (err) {
    console.warn("[vms/register] health check failed (non-fatal)", { baseUrl, error: String(err) });
  }

  const now = new Date().toISOString();
  const { data, error } = await admin
    .from("vms")
    .upsert(
      {
        instance_id: instanceId,
        base_url: baseUrl,
        status: body?.status || "idle",
        runtime_state: body?.runtime_state || "serving",
        last_heartbeat_at: now,
        updated_at: now,
        created_at: now,
      },
      { onConflict: "instance_id" },
    )
    .select("*")
    .single();
  if (error) {
    console.error("[vms/register] upsert failed", { error: error.message });
    return json({ error: error.message }, 500);
  }
  console.info("[vms/register] success", { vmId: data?.id, instanceId });
  return json({ vm: data });
}

async function handleVmHeartbeat(req: Request, body: any) {
  const { service } = await getUserOrService(req, { allowServiceKey: true });
  if (!service) return json({ error: "unauthorized" }, 401);
  const instanceId = body?.instance_id || body?.instanceId;
  console.info("[vms/heartbeat]", { instanceId, status: body?.status, runtime_state: body?.runtime_state });
  if (!instanceId) return json({ error: "missing_instance_id" }, 400);
  const updates: Record<string, unknown> = {
    last_heartbeat_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  const allowed = new Set([
    "base_url",
    "status",
    "runtime_state",
    "project_id",
    "desired_build_id",
    "lease_owner",
    "lease_expires_at",
    "last_start_at",
    "last_shutdown_at",
    "current_source_tar_gz",
  ]);
  for (const [key, value] of Object.entries(body ?? {})) {
    if (allowed.has(key)) updates[key] = value;
  }
  const { error } = await admin.from("vms").update(updates).eq("instance_id", instanceId);
  if (error) return json({ error: error.message }, 500);
  return json({ ok: true });
}

async function handleReleaseVm(req: Request, body: any) {
  const { service } = await getUserOrService(req, { allowServiceKey: true });
  if (!service) return json({ error: "unauthorized" }, 401);
  const instanceId = body?.instance_id || body?.instanceId;
  if (!instanceId) return json({ error: "missing_instance_id" }, 400);
  const now = new Date().toISOString();
  const { error } = await admin
    .from("vms")
    .update({
      status: "idle",
      runtime_state: "serving",
      project_id: null,
      desired_build_id: null,
      lease_owner: null,
      lease_expires_at: null,
      last_shutdown_at: now,
      updated_at: now,
    })
    .eq("instance_id", instanceId);
  if (error) return json({ error: error.message }, 500);
  return json({ ok: true });
}

async function handlePatchVm(req: Request, projectId: string, body: any) {
  const { service } = await getUserOrService(req, { allowServiceKey: true });
  if (!service) return json({ error: "unauthorized" }, 401);
  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  const allowed = new Set([
    "runtime_state",
    "lease_owner",
    "lease_expires_at",
    "last_start_at",
    "last_shutdown_at",
    "last_heartbeat_at",
    "current_source_tar_gz",
  ]);
  for (const [key, value] of Object.entries(body ?? {})) {
    if (allowed.has(key)) updates[key] = value;
  }
  if (Object.keys(updates).length === 1) return json({ ok: true });
  const { error } = await admin.from("vms").update(updates).eq("project_id", projectId);
  if (error) return json({ error: error.message }, 500);
  return json({ ok: true });
}

/**
 * Acquire a VM for a project. Used for testing VM lifecycle.
 * POST /vm/acquire or /vms/acquire
 * Body: { project_id: string }
 */
async function handleAcquireVm(req: Request, body: any) {
  const { service } = await getUserOrService(req, { allowServiceKey: true });
  if (!service) return json({ error: "unauthorized" }, 401);
  const projectId = body?.project_id || body?.projectId;
  if (!projectId) return json({ error: "missing_project_id" }, 400);
  try {
    const { vm } = await startVm({ projectId, mode: "building" });
    return json({ vm });
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes("no idle vms")) {
      return json({ error: "no idle vms available" }, 503);
    }
    return json({ error: msg }, 500);
  }
}

export async function handleVms(req: Request, segments: string[], _url: URL, body: any) {
  const method = req.method.toUpperCase();
  // Support both /vm and /vms prefixes
  if (segments[0] !== "vms" && segments[0] !== "vm") return null;
  if (method === "POST" && segments.length === 2 && segments[1] === "register") {
    return handleRegisterVm(req, body);
  }
  if (method === "POST" && segments.length === 2 && segments[1] === "heartbeat") {
    return handleVmHeartbeat(req, body);
  }
  if (method === "POST" && segments.length === 2 && segments[1] === "release") {
    return handleReleaseVm(req, body);
  }
  if (method === "POST" && segments.length === 2 && segments[1] === "acquire") {
    return handleAcquireVm(req, body);
  }
  if (method === "GET" && segments.length === 2) {
    return handleGetVm(req, segments[1]);
  }
  if (method === "POST" && segments.length === 3 && segments[2] === "heartbeat") {
    return handlePostVmHeartbeat(req, segments[1], body);
  }
  if (method === "PATCH" && segments.length === 2) {
    return handlePatchVm(req, segments[1], body);
  }
  return null;
}
