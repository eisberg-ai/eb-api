import { json } from "../lib/response.ts";
import { admin } from "../lib/env.ts";
import { ensureProject, setProjectStatus, type ProjectStatus } from "../lib/project.ts";
import { promoteBuild } from "../lib/build.ts";
import { getUserOrService } from "../lib/auth.ts";
import { parseBuildErrorCode } from "../lib/buildErrors.ts";
import { normalizeErrorMessage } from "../lib/buildFailure.ts";
import { queueJob } from "./job.ts";

type BuildStatus = "pending" | "queued" | "running" | "succeeded" | "failed";
const MAX_RETRIES = 3;

async function promoteNextStagedBuild(completedBuildId: string, projectId: string) {
  /**
   * When a build succeeds, find any pending build depending on it and queue it.
   */
  const { data: nextBuild, error: findErr } = await admin
    .from("builds")
    .select("*")
    .eq("depends_on_build_id", completedBuildId)
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (findErr || !nextBuild) return null;
  // extract payload from build metadata
  const metadata = (nextBuild.metadata as Record<string, any>) ?? {};
  const messageId = metadata.message_id ?? null;
  const content = metadata.content ?? null;
  const attachments = metadata.attachments ?? null;
  if (!content) {
    console.error("[staging] missing content in build metadata", { buildId: nextBuild.id });
    return null;
  }
  // get project owner for job
  const { data: project } = await admin
    .from("projects")
    .select("owner_user_id")
    .eq("id", projectId)
    .single();
  if (!project) {
    console.error("[staging] project not found", { projectId });
    return null;
  }
  // create job and queue the build
  try {
    const job = await queueJob({
      projectId,
      buildId: nextBuild.id,
      model: nextBuild.model ?? null,
      workspaceId: nextBuild.workspace_id ?? null,
      payload: { message_id: messageId, content, attachments },
      ownerUserId: project.owner_user_id,
    });
    // update build to queued and set as latest
    await admin.from("builds").update({ status: "queued" }).eq("id", nextBuild.id);
    await admin.from("projects").update({ latest_build_id: nextBuild.id, status: "building" }).eq("id", projectId);
    console.info("[staging] promoted build", { buildId: nextBuild.id, jobId: job.job_id });
    return { build: nextBuild, job };
  } catch (err) {
    console.error("[staging] failed to queue build", { buildId: nextBuild.id, error: err });
    // mark the staging build as failed
    await admin.from("builds").update({
      status: "failed",
      error_code: "staging_promotion_failed",
      error_message: (err as Error).message,
      ended_at: new Date().toISOString(),
    }).eq("id", nextBuild.id);
    return null;
  }
}

async function handlePostBuild(body: any) {
  const buildId = (body.id ?? `build-${Date.now()}`).toString();
  const projectId = body.project_id as string;
  const vnum = Number(body.version_number ?? 1) || 1;
  await ensureProject(projectId);
  const model = body.model ?? null;
  const insertPayload = {
    id: buildId,
    project_id: projectId,
    job_id: body.job_id ?? null,
    version_number: vnum,
    status: (body.status as BuildStatus) ?? "queued",
    tasks: body.tasks ?? [],
    artifacts: body.artifacts ?? null,
    started_at: body.started_at ?? new Date().toISOString(),
    model,
    workspace_id: body.workspace_id ?? null,
    error_code: body.error_code ?? null,
    error_message: body.error_message ?? null,
    retry_of_build_id: body.retry_of_build_id ?? null,
  };
  const { data, error } = await admin.from("builds").insert(insertPayload).select("*").single();
  if (error || !data) return json({ error: error?.message || "failed to create build" }, 500);
  await admin.from("projects").update({ latest_build_id: buildId, status: "building" }).eq("id", projectId);
  return json({
    id: data.id,
    project_id: data.project_id,
    job_id: data.job_id,
    version_id: data.version_number ?? vnum,
    status: data.status,
    tasks: data.tasks ?? [],
    artifacts: data.artifacts ?? null,
    started_at: data.started_at,
    ended_at: data.ended_at,
    model: data.model,
    workspace_id: data.workspace_id,
    error_code: data.error_code ?? null,
    error_message: data.error_message ?? null,
    retry_of_build_id: data.retry_of_build_id ?? null,
  });
}

async function handleGetBuild(buildId: string) {
  const { data, error } = await admin.from("builds").select("*").eq("id", buildId).single();
  if (error || !data) return json({ error: "Build not found" }, 404);
  return json({
    id: data.id,
    project_id: data.project_id,
    job_id: data.job_id,
    version_id: data.version_number,
    status: data.status,
    tasks: data.tasks ?? [],
    artifacts: data.artifacts ?? null,
    metadata: data.metadata ?? null,
    started_at: data.started_at,
    ended_at: data.ended_at,
    model: data.model,
    agent_version: data.agent_version,
    workspace_id: data.workspace_id,
    error_code: data.error_code ?? null,
    error_message: data.error_message ?? null,
    retry_of_build_id: data.retry_of_build_id ?? null,
  });
}

async function handlePatchBuildTasks(buildId: string, body: any) {
  const tasks = body.tasks;
  const { error } = await admin.from("builds").update({ tasks }).eq("id", buildId);
  if (error) return json({ error: error.message }, 500);
  return json({ ok: true });
}

async function handlePatchBuild(buildId: string, body: any) {
  const updates: any = {};
  if (body.status) updates.status = body.status;
  if (body.ended_at || body.endedAt) updates.ended_at = body.ended_at ?? body.endedAt;
  if (body.started_at || body.startedAt) updates.started_at = body.started_at ?? body.startedAt;
  if (body.artifacts) updates.artifacts = body.artifacts;
  if (body.tasks) updates.tasks = body.tasks;
  if (body.job_id !== undefined) updates.job_id = body.job_id;
  if (body.agent_version !== undefined) updates.agent_version = body.agent_version;
  if (body.metadata !== undefined) updates.metadata = body.metadata;

  const rawErrorCode = body.error_code ?? body.errorCode;
  const parsedCode = parseBuildErrorCode(rawErrorCode);
  if (rawErrorCode !== undefined) {
    updates.error_code = parsedCode ?? (rawErrorCode ? "unknown" : null);
  }
  const rawErrorMessage = body.error_message ?? body.errorMessage;
  if (rawErrorMessage !== undefined) {
    updates.error_message = normalizeErrorMessage(rawErrorMessage);
  }
  // if status moves away from failed, clear error fields unless explicitly provided
  if (updates.status && updates.status !== "failed") {
    if (rawErrorCode === undefined) updates.error_code = null;
    if (rawErrorMessage === undefined) updates.error_message = null;
  }

  const { data: build } = await admin.from("builds").select("project_id, model").eq("id", buildId).single();
  if (!build) return json({ error: "Build not found" }, 404);
  const { data, error } = await admin.from("builds").update(updates).eq("id", buildId).select("*").single();
  if (error || !data) return json({ error: error?.message || "update failed" }, 500);
  if (updates.status && (updates.status === "succeeded" || updates.status === "failed")) {
    const projectStatus: ProjectStatus = updates.status === "succeeded" ? "active" : "failed";
    await setProjectStatus(build.project_id, projectStatus);
  }
  // when build succeeds, check for and promote any staged builds
  if (updates.status === "succeeded") {
    await promoteNextStagedBuild(buildId, build.project_id);
  }
  if (body.status === "succeeded" && (body.is_promoted || body.promote)) {
    try {
      await promoteBuild(build.project_id, buildId, body.version_number, body.artifacts);
    } catch (err: any) {
      if (err.message === "insufficient_balance") {
        return json({ error: "insufficient_balance", message: "Not enough credits to promote build" }, 402);
      }
      throw err;
    }
  }
  return json({
    id: data.id,
    project_id: data.project_id,
    job_id: data.job_id,
    version_id: data.version_number,
    status: data.status,
    tasks: data.tasks ?? [],
    artifacts: data.artifacts ?? null,
    started_at: data.started_at,
    ended_at: data.ended_at,
    error_code: data.error_code ?? null,
    error_message: data.error_message ?? null,
    retry_of_build_id: data.retry_of_build_id ?? null,
  });
}

async function handlePostWorkerVersion(req: Request, body: any) {
  const { service } = await getUserOrService(req, { allowServiceKey: true });
  if (!service) return json({ error: "unauthorized" }, 401);
  const projectId = (body.project_id ?? "project-alpha").toString();
  const version = Number(body.version ?? 1);
  const webPreviewUrl = body.web_preview_url ?? null;
  await ensureProject(projectId);
  const { data: build } = await admin
    .from("builds")
    .select("id")
    .eq("project_id", projectId)
    .order("created_at", { ascending: false })
    .limit(1)
    .single();
  let buildId = build?.id ?? `build-${projectId}-${version}`;
  if (!build) {
    await admin.from("builds").insert({ id: buildId, project_id: projectId, status: "succeeded" });
  }
  const artifacts = webPreviewUrl ? { web: webPreviewUrl, mobile: body.mobile_preview_url ?? webPreviewUrl } : null;
  await promoteBuild(projectId, buildId, version, artifacts ?? undefined);
  return json({ ok: true, project_id: projectId, version });
}

async function handlePostBuildSteps(body: any) {
  const step = body;
  const { error } = await admin.from("build_steps").upsert(step);
  if (error) return json({ error: error.message }, 500);
  return json({ ok: true });
}

async function handleDeleteStagedBuild(req: Request, buildId: string) {
  /**
   * Deletes a staged build and repairs the dependency chain.
   */
  const { user } = await getUserOrService(req);
  if (!user) return json({ error: "unauthorized" }, 401);
  // get the build
  const { data: build, error: buildErr } = await admin
    .from("builds")
    .select("id, project_id, status, depends_on_build_id, metadata")
    .eq("id", buildId)
    .single();
  if (buildErr || !build) return json({ error: "Build not found" }, 404);
  // verify it's a staged build (pending with depends_on)
  if (build.status !== "pending" || !build.depends_on_build_id) {
    return json({ error: "can_only_delete_staged", message: "Can only delete staged builds" }, 400);
  }
  // verify ownership
  const { data: project } = await admin
    .from("projects")
    .select("owner_user_id")
    .eq("id", build.project_id)
    .single();
  if (!project || project.owner_user_id !== user.id) {
    return json({ error: "forbidden" }, 403);
  }
  // repair chain: any build depending on this one should now depend on this build's dependency
  const { error: repairErr } = await admin
    .from("builds")
    .update({ depends_on_build_id: build.depends_on_build_id })
    .eq("depends_on_build_id", buildId);
  if (repairErr) {
    console.error("[builds] chain repair failed", { buildId, error: repairErr });
  }
  // also delete the associated message if it exists
  const messageId = (build.metadata as any)?.message_id;
  if (messageId) {
    await admin.from("messages").delete().eq("id", messageId);
  }
  // delete the build
  const { error: deleteErr } = await admin.from("builds").delete().eq("id", buildId);
  if (deleteErr) return json({ error: deleteErr.message }, 500);
  return json({ ok: true, deleted_build_id: buildId });
}

async function handleGetBuildByJobId(jobId: string) {
  const { data, error } = await admin
    .from("builds")
    .select("*")
    .eq("job_id", jobId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return json({ error: "Build not found" }, 404);
  return json({
    id: data.id,
    project_id: data.project_id,
    job_id: data.job_id,
    version_id: data.version_number,
    status: data.status,
    tasks: data.tasks ?? [],
    artifacts: data.artifacts ?? null,
    metadata: data.metadata ?? null,
    started_at: data.started_at,
    ended_at: data.ended_at,
    model: data.model,
    agent_version: data.agent_version,
    workspace_id: data.workspace_id,
    error_code: data.error_code ?? null,
    error_message: data.error_message ?? null,
    retry_of_build_id: data.retry_of_build_id ?? null,
  });
}

async function handlePostBuildRetry(req: Request, buildId: string, body: any) {
  const { user } = await getUserOrService(req);
  if (!user) return json({ error: "unauthorized" }, 401);
  // get build
  const { data: build, error: buildErr } = await admin.from("builds").select("*").eq("id", buildId).single();
  if (buildErr || !build) return json({ error: "Build not found" }, 404);
  // verify build is failed
  if (build.status !== "failed") {
    return json({ error: "can_only_retry_failed", message: "Can only retry failed builds" }, 400);
  }
  // check ownership
  const { data: project } = await admin.from("projects").select("owner_user_id").eq("id", build.project_id).single();
  if (!project || project.owner_user_id !== user.id) {
    return json({ error: "forbidden" }, 403);
  }
  // hard-block retries when user has 0 credits
  const { data: balanceRow, error: balanceErr } = await admin
    .from("credit_balances")
    .select("balance")
    .eq("user_id", user.id)
    .maybeSingle();
  if (balanceErr) return json({ error: balanceErr.message }, 500);
  const balance = balanceRow?.balance ?? 0;
  if (balance <= 0) {
    return json({ error: "insufficient_balance", balance }, 402);
  }
  const rootBuildId = build.retry_of_build_id ?? build.id;
  // count previous attempts (root + retries)
  const { data: attempts, error: attemptsErr } = await admin
    .from("builds")
    .select("id")
    .or(`id.eq.${rootBuildId},retry_of_build_id.eq.${rootBuildId}`);
  if (attemptsErr) return json({ error: attemptsErr.message }, 500);
  const retryCount = Math.max(0, (attempts?.length ?? 0) - 1);
  if (retryCount >= MAX_RETRIES) {
    return json({ error: "max_retries_exceeded", message: `Maximum retries (${MAX_RETRIES}) exceeded` }, 400);
  }

  const metadata = (build.metadata as Record<string, any>) ?? {};
  const requestPayload = (body?.payload && typeof body.payload === "object")
    ? body.payload as Record<string, any>
    : null;
  let messageId = (metadata.message_id ?? metadata.messageId ?? null) as string | null;
  if (!messageId) {
    messageId = (body?.message_id ?? body?.messageId ?? null) as string | null;
  }
  if (!messageId && requestPayload) {
    messageId = (requestPayload.message_id ?? requestPayload.messageId ?? null) as string | null;
  }
  let jobPayload: Record<string, any> | null = null;
  if (build.job_id) {
    const { data: jobRow, error: jobErr } = await admin
      .from("jobs")
      .select("payload")
      .eq("job_id", build.job_id)
      .maybeSingle();
    if (jobErr) return json({ error: jobErr.message }, 500);
    if (jobRow?.payload && typeof jobRow.payload === "object") {
      jobPayload = jobRow.payload as Record<string, any>;
    }
  }
  if (!messageId && jobPayload) {
    messageId = (jobPayload.message_id ?? jobPayload.messageId ?? null) as string | null;
  }

  let messageRow: { id: string; content: string | null; attachments: any; model: string | null } | null = null;
  if (messageId) {
    const { data: row, error: msgErr } = await admin
      .from("messages")
      .select("id, content, attachments, model")
      .eq("id", messageId)
      .maybeSingle();
    if (msgErr) return json({ error: msgErr.message }, 500);
    messageRow = row ?? null;
  }

  let fallbackMessage: { id: string; content: string | null; attachments: any; model: string | null } | null = null;
  if (!messageRow) {
    const { data: lastMessage, error: lastMsgErr } = await admin
      .from("messages")
      .select("id, content, attachments, model")
      .eq("project_id", build.project_id)
      .eq("type", "user")
      .order("sequence_number", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (lastMsgErr) return json({ error: lastMsgErr.message }, 500);
    fallbackMessage = lastMessage ?? null;
  }

  const resolvedMessage = messageRow ?? fallbackMessage ?? null;
  const resolvedMessageId = resolvedMessage?.id ?? messageId ?? null;
  const resolvedPayload = (() => {
    if (requestPayload && (requestPayload.content ?? requestPayload.message)) return { ...requestPayload };
    if (resolvedMessage) {
      return {
        message_id: resolvedMessage.id,
        content: resolvedMessage.content,
        attachments: resolvedMessage.attachments ?? null,
      };
    }
    if (jobPayload) return { ...jobPayload };
    return null;
  })();
  if (!resolvedPayload) {
    return json({ error: "message_context_missing", message: "This build cannot be retried (missing message context)" }, 400);
  }
  if (!resolvedPayload.content && resolvedPayload.message) {
    resolvedPayload.content = resolvedPayload.message;
  }
  if (!resolvedPayload.content) {
    return json({ error: "message_context_missing", message: "This build cannot be retried (missing message context)" }, 400);
  }
  if (resolvedMessageId && resolvedPayload.message_id == null && resolvedPayload.messageId == null) {
    resolvedPayload.message_id = resolvedMessageId;
  }

  const newBuildId = `build-${Date.now()}`;
  const updatedMetadata = { ...metadata, retry_count: retryCount + 1 };
  if (resolvedMessageId) updatedMetadata.message_id = resolvedMessageId;
  const resolvedModel = build.model ?? resolvedMessage?.model ?? null;
  const { error: insertErr } = await admin.from("builds").insert({
    id: newBuildId,
    project_id: build.project_id,
    version_number: build.version_number,
    status: "pending",
    tasks: [],
    artifacts: null,
    metadata: updatedMetadata,
    model: resolvedModel,
    workspace_id: build.workspace_id ?? null,
    retry_of_build_id: rootBuildId,
    error_code: null,
    error_message: null,
    started_at: null,
    ended_at: null,
  });
  if (insertErr) return json({ error: insertErr.message }, 500);
  await admin.from("projects").update({ latest_build_id: newBuildId }).eq("id", build.project_id);

  try {
    const job = await queueJob({
      projectId: build.project_id,
      buildId: newBuildId,
      model: resolvedModel,
      workspaceId: build.workspace_id ?? null,
      payload: resolvedPayload,
      ownerUserId: user.id,
    });
    await admin.from("builds").update({ status: "queued" }).eq("id", newBuildId);
    return json({
      ok: true,
      build: { id: newBuildId, status: "queued", retry_count: retryCount + 1, retry_of_build_id: rootBuildId },
      job,
    });
  } catch (err) {
    const errorMsg = (err as Error).message;
    await admin.from("builds").update({
      status: "failed",
      error_code: "worker_error",
      error_message: errorMsg,
      ended_at: new Date().toISOString(),
    }).eq("id", newBuildId);
    return json({ error: errorMsg }, 500);
  }
}

export async function handleBuilds(req: Request, segments: string[], url: URL, body: any) {
  const method = req.method.toUpperCase();
  // POST /builds
  if (method === "POST" && segments[0] === "builds" && segments.length === 1) {
    return handlePostBuild(body);
  }
  // GET /builds?jobId=xxx
  if (method === "GET" && segments[0] === "builds" && segments.length === 1) {
    const jobId = url.searchParams.get("jobId");
    if (jobId) return handleGetBuildByJobId(jobId);
    return json({ error: "jobId query param required" }, 400);
  }
  // GET /builds/{id}
  if (method === "GET" && segments[0] === "builds" && segments.length === 2) {
    return handleGetBuild(segments[1]);
  }
  // POST /builds/{id}/retry
  if (method === "POST" && segments[0] === "builds" && segments[2] === "retry") {
    return handlePostBuildRetry(req, segments[1], body);
  }
  // DELETE /builds/{id}/staged
  if (method === "DELETE" && segments[0] === "builds" && segments[2] === "staged") {
    return handleDeleteStagedBuild(req, segments[1]);
  }
  // PATCH /builds/{id}/tasks
  if (method === "PATCH" && segments[0] === "builds" && segments[2] === "tasks") {
    return handlePatchBuildTasks(segments[1], body);
  }
  // PATCH /builds/{id}
  if (method === "PATCH" && segments[0] === "builds" && segments.length === 2) {
    return handlePatchBuild(segments[1], body);
  }
  // POST /worker/version
  if (method === "POST" && segments[0] === "worker" && segments[1] === "version") {
    return handlePostWorkerVersion(req, body);
  }
  // POST /build_steps
  if (method === "POST" && segments[0] === "build_steps") {
    return handlePostBuildSteps(body);
  }
  return null;
}
