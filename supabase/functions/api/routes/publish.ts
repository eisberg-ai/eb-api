import { json } from "../lib/response.ts";
import { admin, publishSecretKey, publishSecretKeyId } from "../lib/env.ts";
import { getUserOrService } from "../lib/auth.ts";
import { decryptJson, encryptJson } from "../lib/crypto.ts";

type PublishSessionRow = {
  id: string;
  project_id: string;
  workspace_id: string | null;
  user_id: string | null;
  status: string;
  active_step: number;
  form_data: Record<string, unknown> | null;
  logs: unknown[] | null;
  last_error: string | null;
  secrets_id: string | null;
  secrets_meta: Record<string, unknown> | null;
  submission_started_at: string | null;
  submitted_at: string | null;
  created_at: string;
  updated_at: string;
};

type PublishSecretsPayload = {
  authMethod?: "apple_password" | "app_store_connect";
  apple?: { password?: string | null };
  expo?: { accessToken?: string | null };
  connectApi?: Record<string, unknown> | null;
};

const DEFAULT_PREREQS = [
  { id: "apple-membership", label: "Apple Developer Program membership active", checked: true },
  { id: "agreements", label: "App Store Connect agreements signed", checked: true },
  { id: "2fa", label: "Two-factor authentication enabled", checked: true },
  { id: "bundle", label: "Bundle ID reserved in App Store Connect", checked: false },
];

const DEFAULT_FORM_DATA = {
  version: 1,
  authMethod: "apple_password",
  prereqs: DEFAULT_PREREQS,
  details: {
    appName: "",
    version: "1.0.0",
    buildNumber: "1",
    bundleId: "",
    supportsIpad: true,
  },
  apple: {
    email: "",
    teamId: "",
  },
  expo: {},
  icon: {
    fileName: null,
    preview: null,
    notes: "",
    mode: "none",
  },
  projectVersion: null,
};

const STATUS_VALUES = new Set(["draft", "submitting", "failed", "submitted"]);

function normalizeStatus(status?: string | null) {
  if (!status) return null;
  const trimmed = status.trim();
  return STATUS_VALUES.has(trimmed) ? trimmed : null;
}

function normalizeNumber(value: unknown, fallback: number) {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toIso(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "number") return new Date(value).toISOString();
  if (typeof value === "string") {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  return null;
}

function mapSession(row: PublishSessionRow) {
  return {
    id: row.id,
    projectId: row.project_id,
    workspaceId: row.workspace_id,
    userId: row.user_id,
    status: row.status,
    activeStep: row.active_step,
    formData: row.form_data ?? {},
    logs: row.logs ?? [],
    lastError: row.last_error ?? null,
    secretsMeta: row.secrets_meta ?? {},
    submissionStartedAt: row.submission_started_at ?? null,
    submittedAt: row.submitted_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function sanitizeFormData(input: Record<string, unknown>) {
  const formData = { ...input };
  const apple = formData.apple;
  if (apple && typeof apple === "object") {
    const { password, ...rest } = apple as Record<string, unknown>;
    formData.apple = rest;
  }
  const expo = formData.expo;
  if (expo && typeof expo === "object") {
    const { accessToken, ...rest } = expo as Record<string, unknown>;
    formData.expo = rest;
  }
  return formData;
}

async function assertProjectAccess(userId: string, projectId: string) {
  const { data: project, error } = await admin
    .from("projects")
    .select("id, name, owner_user_id, workspace_id, current_version_number")
    .eq("id", projectId)
    .single();
  if (error || !project) {
    throw new Error("not_found");
  }
  if (project.owner_user_id === userId) return project;
  if (!project.workspace_id) {
    throw new Error("forbidden");
  }
  const { data: member } = await admin
    .from("workspace_members")
    .select("user_id")
    .eq("workspace_id", project.workspace_id)
    .eq("user_id", userId)
    .eq("status", "active")
    .maybeSingle();
  if (!member) {
    throw new Error("forbidden");
  }
  return project;
}

function accessErrorResponse(err: unknown) {
  if (err instanceof Error) {
    if (err.message === "not_found") return json({ error: "not_found" }, 404);
    if (err.message === "forbidden") return json({ error: "forbidden" }, 403);
  }
  return json({ error: "forbidden" }, 403);
}

function buildDefaultFormData(projectId: string, projectName?: string | null, projectVersion?: number | null) {
  return {
    ...DEFAULT_FORM_DATA,
    details: {
      ...DEFAULT_FORM_DATA.details,
      appName: projectName || "Project",
      bundleId: `ai.eisberg.${projectId.replace(/[^a-zA-Z0-9]+/g, "")}`,
    },
    projectVersion: projectVersion ?? null,
  };
}

async function upsertSecrets(session: PublishSessionRow, secrets: PublishSecretsPayload) {
  const secretKey = publishSecretKey;
  if (!secretKey) {
    throw new Error("publish_secret_not_configured");
  }

  let existingPayload: PublishSecretsPayload = {};
  if (session.secrets_id) {
    const { data: existing } = await admin
      .from("publish_secrets")
      .select("payload_encrypted")
      .eq("id", session.secrets_id)
      .maybeSingle();
    if (existing?.payload_encrypted) {
      existingPayload = await decryptJson<PublishSecretsPayload>(secretKey, existing.payload_encrypted);
    }
  }

  const nextPayload: PublishSecretsPayload = {
    ...existingPayload,
    authMethod: secrets.authMethod ?? existingPayload.authMethod ?? "apple_password",
    apple: {
      ...(existingPayload.apple ?? {}),
      ...(secrets.apple ?? {}),
    },
    expo: {
      ...(existingPayload.expo ?? {}),
      ...(secrets.expo ?? {}),
    },
    connectApi: secrets.connectApi ?? existingPayload.connectApi ?? null,
  };

  const encrypted = await encryptJson(secretKey, nextPayload);
  let secretsId = session.secrets_id;

  if (secretsId) {
    await admin
      .from("publish_secrets")
      .update({
        payload_encrypted: encrypted,
        key_id: publishSecretKeyId,
        updated_at: new Date().toISOString(),
      })
      .eq("id", secretsId);
  } else {
    const { data: inserted, error } = await admin
      .from("publish_secrets")
      .insert({
        user_id: session.user_id,
        payload_encrypted: encrypted,
        key_id: publishSecretKeyId,
      })
      .select("id")
      .single();
    if (error || !inserted?.id) {
      throw new Error("secrets_insert_failed");
    }
    secretsId = inserted.id as string;
  }

  const secretsMeta = {
    authMethod: nextPayload.authMethod ?? "apple_password",
    hasApplePassword: Boolean(nextPayload.apple?.password),
    hasExpoAccessToken: Boolean(nextPayload.expo?.accessToken),
    hasConnectApi: Boolean(nextPayload.connectApi),
  };

  await admin
    .from("publish_sessions")
    .update({
      secrets_id: secretsId,
      secrets_meta: secretsMeta,
      updated_at: new Date().toISOString(),
    })
    .eq("id", session.id);
}

async function handleGetSession(req: Request, url: URL) {
  const { user } = await getUserOrService(req);
  if (!user) return json({ error: "unauthorized" }, 401);

  const sessionId = url.searchParams.get("sessionId");
  const projectId = url.searchParams.get("projectId");
  if (!sessionId && !projectId) return json({ error: "projectId or sessionId required" }, 400);

  if (sessionId) {
    const { data: session } = await admin
      .from("publish_sessions")
      .select("*")
      .eq("id", sessionId)
      .maybeSingle();
    if (!session) return json({ error: "not_found" }, 404);
    try {
      await assertProjectAccess(user.id, session.project_id);
    } catch (err) {
      return accessErrorResponse(err);
    }
    return json({ session: mapSession(session as PublishSessionRow) });
  }

  let project;
  try {
    project = await assertProjectAccess(user.id, projectId!);
  } catch (err) {
    return accessErrorResponse(err);
  }
  const { data: existing } = await admin
    .from("publish_sessions")
    .select("*")
    .eq("project_id", projectId!)
    .order("created_at", { ascending: false })
    .limit(1);

  if (existing && existing.length > 0) {
    return json({ session: mapSession(existing[0] as PublishSessionRow) });
  }

  const formData = buildDefaultFormData(projectId!, project.name, project.current_version_number ?? null);
  const { data: inserted, error } = await admin
    .from("publish_sessions")
    .insert({
      project_id: projectId!,
      workspace_id: project.workspace_id ?? null,
      user_id: user.id,
      status: "draft",
      active_step: 0,
      form_data: formData,
      logs: [],
      secrets_meta: { authMethod: "apple_password" },
    })
    .select("*")
    .single();
  if (error || !inserted) {
    console.error("[publish] session_create_failed", error);
    return json({ error: "session_create_failed", detail: error?.message }, 500);
  }
  return json({ session: mapSession(inserted as PublishSessionRow) });
}

async function handleListSessions(req: Request, url: URL) {
  const { user } = await getUserOrService(req);
  if (!user) return json({ error: "unauthorized" }, 401);
  const projectId = url.searchParams.get("projectId");
  if (!projectId) return json({ error: "projectId required" }, 400);
  try {
    await assertProjectAccess(user.id, projectId);
  } catch (err) {
    return accessErrorResponse(err);
  }
  const limit = Math.max(1, Math.min(50, Number(url.searchParams.get("limit") ?? 20)));
  const { data, error } = await admin
    .from("publish_sessions")
    .select("*")
    .eq("project_id", projectId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) return json({ error: error.message }, 500);
  return json({ sessions: (data ?? []).map((row: any) => mapSession(row as PublishSessionRow)) });
}

async function handleCreateSession(req: Request, body: any) {
  const { user } = await getUserOrService(req);
  if (!user) return json({ error: "unauthorized" }, 401);
  const projectId = body?.projectId ?? body?.project_id;
  if (!projectId) return json({ error: "projectId required" }, 400);
  let project;
  try {
    project = await assertProjectAccess(user.id, projectId);
  } catch (err) {
    return accessErrorResponse(err);
  }

  let formData = buildDefaultFormData(projectId, project.name, project.current_version_number ?? null);
  let secretsId: string | null = null;
  let secretsMeta: Record<string, unknown> = { authMethod: "apple_password" };

  const cloneId = body?.cloneSessionId ?? body?.clone_session_id;
  if (cloneId) {
    const { data: clone } = await admin
      .from("publish_sessions")
      .select("*")
      .eq("id", cloneId)
      .maybeSingle();
    if (clone && clone.project_id === projectId) {
      formData = (clone.form_data ?? formData) as Record<string, unknown>;
      secretsId = clone.secrets_id ?? null;
      secretsMeta = (clone.secrets_meta ?? secretsMeta) as Record<string, unknown>;
    }
  }

  if (body?.formData && typeof body.formData === "object") {
    formData = sanitizeFormData(body.formData);
  }

  const activeStep = normalizeNumber(body?.activeStep, 0);
  const status = normalizeStatus(body?.status) ?? "draft";
  const logs = Array.isArray(body?.logs) ? body.logs : [];
  const submissionStartedAt = body?.submissionStartedAt ? toIso(body.submissionStartedAt) : null;
  const submittedAt = body?.submittedAt ? toIso(body.submittedAt) : null;
  const lastError = body?.lastError ?? null;

  const { data: inserted, error } = await admin
    .from("publish_sessions")
    .insert({
      project_id: projectId,
      workspace_id: project.workspace_id ?? null,
      user_id: user.id,
      status,
      active_step: activeStep,
      form_data: sanitizeFormData(formData),
      logs,
      secrets_id: secretsId,
      secrets_meta: secretsMeta,
      submission_started_at: submissionStartedAt,
      submitted_at: submittedAt,
      last_error: lastError,
    })
    .select("*")
    .single();
  if (error || !inserted) {
    console.error("[publish] session_create_failed", error);
    return json({ error: "session_create_failed", detail: error?.message }, 500);
  }
  return json({ session: mapSession(inserted as PublishSessionRow) });
}

async function handleUpdateSession(req: Request, body: any) {
  const { user } = await getUserOrService(req);
  if (!user) return json({ error: "unauthorized" }, 401);
  const sessionId = body?.sessionId ?? body?.session_id;
  if (!sessionId) return json({ error: "sessionId required" }, 400);

  const { data: session } = await admin
    .from("publish_sessions")
    .select("*")
    .eq("id", sessionId)
    .maybeSingle();
  if (!session) return json({ error: "not_found" }, 404);
  try {
    await assertProjectAccess(user.id, session.project_id);
  } catch (err) {
    return accessErrorResponse(err);
  }

  const updates: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };

  if (body?.activeStep !== undefined) updates.active_step = normalizeNumber(body.activeStep, session.active_step);
  if (body?.formData && typeof body.formData === "object") {
    updates.form_data = sanitizeFormData(body.formData);
  }
  if (Array.isArray(body?.logs)) updates.logs = body.logs;
  if (body?.lastError !== undefined) updates.last_error = body.lastError ?? null;
  if (body?.submissionStartedAt !== undefined) updates.submission_started_at = toIso(body.submissionStartedAt);
  if (body?.submittedAt !== undefined) updates.submitted_at = toIso(body.submittedAt);

  const normalizedStatus = normalizeStatus(body?.status);
  if (normalizedStatus) updates.status = normalizedStatus;

  const { data: updated, error } = await admin
    .from("publish_sessions")
    .update(updates)
    .eq("id", sessionId)
    .select("*")
    .single();
  if (error || !updated) {
    console.error("[publish] session_update_failed", error);
    return json({ error: "session_update_failed", detail: error?.message }, 500);
  }

  const secrets = body?.secrets as PublishSecretsPayload | undefined;
  if (secrets && typeof secrets === "object") {
    try {
      await upsertSecrets(updated as PublishSessionRow, secrets);
      const { data: refreshed } = await admin
        .from("publish_sessions")
        .select("*")
        .eq("id", sessionId)
        .maybeSingle();
      if (refreshed) {
        return json({ session: mapSession(refreshed as PublishSessionRow) });
      }
    } catch (err: any) {
      return json({ error: err?.message ?? "secrets_update_failed" }, 500);
    }
  }

  return json({ session: mapSession(updated as PublishSessionRow) });
}

export async function handlePublish(req: Request, segments: string[], url: URL, body: any) {
  if (segments[0] !== "publish") return null;
  const method = req.method.toUpperCase();
  if (method === "GET" && segments[1] === "session") {
    return handleGetSession(req, url);
  }
  if (method === "GET" && segments[1] === "sessions") {
    return handleListSessions(req, url);
  }
  if (method === "POST" && segments[1] === "session") {
    return handleCreateSession(req, body);
  }
  if (method === "PATCH" && segments[1] === "session") {
    return handleUpdateSession(req, body);
  }
  return json({ error: "not found" }, 404);
}
