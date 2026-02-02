import { json } from "../lib/response.ts";
import { admin } from "../lib/env.ts";
import { getUserOrService } from "../lib/auth.ts";

interface BackendStats {
  enabled: boolean;
  enabled_at: string | null;
  app_id: string | null;
  db: {
    tables: Array<{ name: string; row_count: number }>;
    total_rows: number;
  } | null;
  functions: {
    endpoints: Array<{ name: string; invocations: number; last_invoked_at: string | null }>;
    total_invocations: number;
  } | null;
  auth: {
    users: number;
    roles: Array<{ role: string; count: number }>;
  } | null;
}

async function ensureProjectAccess(req: Request, projectId: string) {
  const auth = await getUserOrService(req, { allowServiceKey: true });
  const user = auth.user;
  const isService = auth.service;
  if (!user && !isService) return { error: json({ error: "unauthorized" }, 401) };

  const { data: project } = await admin
    .from("projects")
    .select("owner_user_id, backend_enabled, backend_app_id")
    .eq("id", projectId)
    .single();

  if (!project) return { error: json({ error: "not found" }, 404) };

  if (!isService && user && project.owner_user_id !== user.id) {
    return { error: json({ error: "forbidden" }, 403) };
  }

  return { project, user, isService };
}

async function handleGetBackendStatus(req: Request, projectId: string) {
  const access = await ensureProjectAccess(req, projectId);
  if (access.error) return access.error;

  const { project } = access;

  const stats: BackendStats = {
    enabled: !!project.backend_enabled,
    enabled_at: null,
    app_id: project.backend_app_id ?? null,
    db: null,
    functions: null,
    auth: null,
  };

  if (!project.backend_enabled || !project.backend_app_id) {
    return json(stats);
  }

  const appId = project.backend_app_id;
  const appIdNorm = appId.replace(/-/g, "");
  const schemaName = `app_${appIdNorm}`;

  // Get DB stats
  try {
    const { data: tables } = await admin.rpc("get_schema_table_stats", {
      schema_name: schemaName,
    });

    if (tables && Array.isArray(tables)) {
      stats.db = {
        tables: tables.map((t: any) => ({
          name: t.table_name,
          row_count: parseInt(t.row_count, 10) || 0,
        })),
        total_rows: tables.reduce((sum: number, t: any) => sum + (parseInt(t.row_count, 10) || 0), 0),
      };
    } else {
      stats.db = { tables: [], total_rows: 0 };
    }
  } catch (err) {
    console.error("[backend] failed to get db stats", err);
    stats.db = { tables: [], total_rows: 0 };
  }

  // Get function invocation stats (placeholder - would need actual tracking)
  try {
    const { data: functions } = await admin
      .from("backend_function_stats")
      .select("function_name, invocation_count, last_invoked_at")
      .eq("app_id", appId);

    if (functions && Array.isArray(functions)) {
      stats.functions = {
        endpoints: functions.map((f: any) => ({
          name: f.function_name,
          invocations: f.invocation_count || 0,
          last_invoked_at: f.last_invoked_at ?? null,
        })),
        total_invocations: functions.reduce((sum: number, f: any) => sum + (f.invocation_count || 0), 0),
      };
    } else {
      stats.functions = { endpoints: [], total_invocations: 0 };
    }
  } catch (err) {
    // Table may not exist yet
    stats.functions = { endpoints: [], total_invocations: 0 };
  }

  // Get auth stats
  try {
    const { data: authUsers } = await admin
      .from("app_users")
      .select("role")
      .eq("app_id", appId);

    if (authUsers && Array.isArray(authUsers)) {
      const roleCount: Record<string, number> = {};
      authUsers.forEach((u: any) => {
        roleCount[u.role] = (roleCount[u.role] || 0) + 1;
      });
      stats.auth = {
        users: authUsers.length,
        roles: Object.entries(roleCount).map(([role, count]) => ({ role, count })),
      };
    } else {
      stats.auth = { users: 0, roles: [] };
    }
  } catch (err) {
    console.error("[backend] failed to get auth stats", err);
    stats.auth = { users: 0, roles: [] };
  }

  return json(stats);
}

async function handleGetBackendDb(req: Request, projectId: string) {
  const access = await ensureProjectAccess(req, projectId);
  if (access.error) return access.error;

  const { project } = access;

  if (!project.backend_enabled || !project.backend_app_id) {
    return json({ error: "backend_not_enabled" }, 400);
  }

  const appId = project.backend_app_id;
  const appIdNorm = appId.replace(/-/g, "");
  const schemaName = `app_${appIdNorm}`;

  try {
    const { data: tables } = await admin.rpc("get_schema_table_stats", {
      schema_name: schemaName,
    });

    return json({
      schema: schemaName,
      tables: (tables || []).map((t: any) => ({
        name: t.table_name,
        row_count: parseInt(t.row_count, 10) || 0,
        columns: t.columns || [],
      })),
    });
  } catch (err) {
    console.error("[backend] failed to get db info", err);
    return json({ schema: schemaName, tables: [] });
  }
}

async function handleGetBackendFunctions(req: Request, projectId: string) {
  const access = await ensureProjectAccess(req, projectId);
  if (access.error) return access.error;

  const { project } = access;

  if (!project.backend_enabled || !project.backend_app_id) {
    return json({ error: "backend_not_enabled" }, 400);
  }

  const appId = project.backend_app_id;

  try {
    const { data: functions } = await admin
      .from("backend_function_stats")
      .select("function_name, invocation_count, last_invoked_at, created_at")
      .eq("app_id", appId)
      .order("invocation_count", { ascending: false });

    return json({
      functions: (functions || []).map((f: any) => ({
        name: f.function_name,
        invocations: f.invocation_count || 0,
        last_invoked_at: f.last_invoked_at ?? null,
        created_at: f.created_at ?? null,
      })),
      total_invocations: (functions || []).reduce((sum: number, f: any) => sum + (f.invocation_count || 0), 0),
    });
  } catch (err) {
    // Table may not exist
    return json({ functions: [], total_invocations: 0 });
  }
}

async function handleGetBackendAuth(req: Request, projectId: string) {
  const access = await ensureProjectAccess(req, projectId);
  if (access.error) return access.error;

  const { project } = access;

  if (!project.backend_enabled || !project.backend_app_id) {
    return json({ error: "backend_not_enabled" }, 400);
  }

  const appId = project.backend_app_id;

  try {
    const { data: authUsers } = await admin
      .from("app_users")
      .select("user_id, role, created_at")
      .eq("app_id", appId)
      .order("created_at", { ascending: false });

    const roleCount: Record<string, number> = {};
    (authUsers || []).forEach((u: any) => {
      roleCount[u.role] = (roleCount[u.role] || 0) + 1;
    });

    return json({
      users: (authUsers || []).map((u: any) => ({
        user_id: u.user_id,
        role: u.role,
        created_at: u.created_at,
      })),
      total_users: (authUsers || []).length,
      roles: Object.entries(roleCount).map(([role, count]) => ({ role, count })),
    });
  } catch (err) {
    console.error("[backend] failed to get auth info", err);
    return json({ users: [], total_users: 0, roles: [] });
  }
}

async function handleDestroyBackend(req: Request, projectId: string, body: any) {
  const access = await ensureProjectAccess(req, projectId);
  if (access.error) return access.error;

  const { project, isService } = access;

  // Require confirmation
  const confirm = body?.confirm;
  if (confirm !== "DELETE") {
    return json({ error: "confirmation_required", message: "Type DELETE to confirm" }, 400);
  }

  if (!project.backend_enabled && !project.backend_app_id) {
    return json({ error: "backend_not_found" }, 404);
  }

  const appId = project.backend_app_id;
  const appIdNorm = appId ? appId.replace(/-/g, "") : null;
  const schemaName = appIdNorm ? `app_${appIdNorm}` : null;

  const cleanup = {
    services_removed: 0,
    env_vars_cleared: 0,
    auth_users_removed: 0,
    schema_dropped: false,
  };

  // 1. Remove all project services
  try {
    const { data: services } = await admin
      .from("project_services")
      .select("service_stub")
      .eq("project_id", projectId);

    if (services && services.length > 0) {
      await admin
        .from("project_services")
        .delete()
        .eq("project_id", projectId);
      cleanup.services_removed = services.length;
    }
  } catch (err) {
    console.error("[backend] failed to remove services", err);
  }

  // 2. Remove all project service tokens
  try {
    await admin
      .from("project_service_tokens")
      .delete()
      .eq("project_id", projectId);
  } catch (err) {
    console.error("[backend] failed to remove service tokens", err);
  }

  // 3. Clear environment variables
  try {
    const { data: envVars } = await admin
      .from("env_vars")
      .select("id")
      .eq("project_id", projectId);

    if (envVars && envVars.length > 0) {
      await admin
        .from("env_vars")
        .delete()
        .eq("project_id", projectId);
      cleanup.env_vars_cleared = envVars.length;
    }
  } catch (err) {
    console.error("[backend] failed to clear env vars", err);
  }

  // 4. Remove app_users for this app
  if (appId) {
    try {
      const { data: authUsers } = await admin
        .from("app_users")
        .select("user_id")
        .eq("app_id", appId);

      if (authUsers && authUsers.length > 0) {
        await admin
          .from("app_users")
          .delete()
          .eq("app_id", appId);
        cleanup.auth_users_removed = authUsers.length;
      }
    } catch (err) {
      console.error("[backend] failed to remove app users", err);
    }
  }

  // 5. Drop the app schema
  if (schemaName) {
    try {
      const { error: dropErr } = await admin.rpc("drop_app_schema", {
        app_id: appId,
      });
      if (!dropErr) {
        cleanup.schema_dropped = true;
      }
    } catch (err) {
      console.error("[backend] failed to drop schema", err);
    }
  }

  // 6. Remove function stats
  if (appId) {
    try {
      await admin
        .from("backend_function_stats")
        .delete()
        .eq("app_id", appId);
    } catch (err) {
      // Table may not exist
    }
  }

  // 7. Update project to disable backend
  const { error: updateErr } = await admin
    .from("projects")
    .update({
      backend_enabled: false,
      backend_app_id: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", projectId);

  if (updateErr) {
    return json({ error: "failed_to_update_project", message: updateErr.message }, 500);
  }

  return json({
    deleted: true,
    deleted_at: new Date().toISOString(),
    cleanup_summary: cleanup,
  });
}

export async function handleBackend(req: Request, segments: string[], url: URL, body: any) {
  const method = req.method.toUpperCase();

  // Route: /projects/{projectId}/backend
  if (segments[0] !== "projects" || segments[2] !== "backend") return null;

  const projectId = segments[1];
  if (!projectId) return json({ error: "projectId required" }, 400);

  // GET /projects/{id}/backend - Get backend status and stats
  if (method === "GET" && segments.length === 3) {
    return handleGetBackendStatus(req, projectId);
  }

  // GET /projects/{id}/backend/db - Get database stats
  if (method === "GET" && segments.length === 4 && segments[3] === "db") {
    return handleGetBackendDb(req, projectId);
  }

  // GET /projects/{id}/backend/functions - Get function stats
  if (method === "GET" && segments.length === 4 && segments[3] === "functions") {
    return handleGetBackendFunctions(req, projectId);
  }

  // GET /projects/{id}/backend/auth - Get auth stats
  if (method === "GET" && segments.length === 4 && segments[3] === "auth") {
    return handleGetBackendAuth(req, projectId);
  }

  // DELETE /projects/{id}/backend/destroy - Destroy backend completely
  if (method === "DELETE" && segments.length === 4 && segments[3] === "destroy") {
    return handleDestroyBackend(req, projectId, body);
  }

  return null;
}
