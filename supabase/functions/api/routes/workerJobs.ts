import { json } from "../lib/response.ts";
import { admin } from "../lib/env.ts";
import { getUserOrService } from "../lib/auth.ts";
import { nextJob, queueJob } from "./job.ts";
import { setProjectStatus } from "../lib/project.ts";

async function handlePostWorkerJobs(req: Request, body: any) {
  const { user } = await getUserOrService(req);
  if (!user) return json({ error: "unauthorized" }, 401);
  const projectId = (body.project_id ?? body.projectId ?? "project-alpha").toString();
  const buildId = body.build_id ?? body.buildId ?? `build-${Date.now()}`;
  // create build with pending status
  const { error: buildErr } = await admin.from("builds").insert({
    id: buildId,
    project_id: projectId,
    version_number: 1,
    status: "pending",
    metadata: { retry_count: 0 },
    error_code: null,
    error_message: null,
    retry_of_build_id: null,
  });
  if (buildErr) return json({ error: buildErr.message }, 500);
  // update project's latest build
  await admin.from("projects").update({ latest_build_id: buildId }).eq("id", projectId);
  // queue job
  try {
    const job = await queueJob({
      projectId,
      buildId,
      jobId: (body.job_id ?? body.jobId ?? `job-${Date.now()}`).toString(),
      model: body.model ?? null,
      workspaceId: body.workspace_id ?? body.workspaceId ?? null,
      payload: body.payload ?? null,
      ownerUserId: user.id,
    });
    await admin.from("builds").update({ status: "queued" }).eq("id", buildId);
    return json({ ok: true, job, build: { id: buildId, status: "queued" } });
  } catch (err) {
    const errorMsg = (err as Error).message;
    await admin.from("builds").update({
      status: "failed",
      error_code: "worker_error",
      error_message: errorMsg,
      metadata: { retry_count: 0 },
      ended_at: new Date().toISOString(),
    }).eq("id", buildId);
    return json({ error: errorMsg, build: { id: buildId, status: "failed" } }, 500);
  }
}

async function handleGetWorkerJobsNext(req: Request, url: URL) {
  const { service } = await getUserOrService(req, { allowServiceKey: true });
  if (!service) return json({ error: "unauthorized" }, 401);
  const projectId = url.searchParams.get("projectId") ?? url.searchParams.get("project_id") ?? undefined;
  const workerId = req.headers.get("x-worker-id")
    ?? url.searchParams.get("workerId")
    ?? url.searchParams.get("worker_id");
  const job = await nextJob(projectId, workerId);
  if (!job) return json({ ok: false });
  return json({
    ok: true,
    job: {
      job_id: job.job_id,
      project_id: job.project_id,
      model: job.model,
      workspace_id: job.workspace_id,
      payload: job.payload ?? null,
    },
  });
}

async function handleGetWorkerJobs(url: URL) {
  const projectId = url.searchParams.get("projectId") ?? undefined;
  const query = admin.from("jobs").select("job_id,project_id,status,created_at");
  const { data, error } = projectId ? await query.eq("project_id", projectId) : await query;
  if (error) return json({ error: error.message }, 500);
  return json({ jobs: data ?? [] });
}

async function handleGetWorkerJob(req: Request, jobId: string) {
  const { service } = await getUserOrService(req, { allowServiceKey: true });
  if (!service) return json({ error: "unauthorized" }, 401);
  const { data, error } = await admin
    .from("jobs")
    .select("job_id,project_id,status,worker_id,last_heartbeat,created_at,updated_at")
    .eq("job_id", jobId)
    .single();
  if (error) return json({ error: error.message }, 500);
  if (!data) return json({ error: "not found" }, 404);
  return json({ job: data });
}

async function handlePostWorkerJobHeartbeat(req: Request, jobId: string, body: any) {
  const { service } = await getUserOrService(req, { allowServiceKey: true });
  if (!service) return json({ error: "unauthorized" }, 401);
  const workerId = req.headers.get("x-worker-id") ?? body?.worker_id ?? body?.workerId ?? null;
  const updates: Record<string, unknown> = {
    last_heartbeat: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  if (workerId) updates.worker_id = workerId;
  const { error } = await admin.from("jobs").update(updates).eq("job_id", jobId);
  if (error) return json({ error: error.message }, 500);
  return json({ ok: true });
}

async function handleGetWorkerJobProject(req: Request, jobId: string) {
  const { service } = await getUserOrService(req, { allowServiceKey: true });
  if (!service) return json({ error: "unauthorized" }, 401);
  console.log("[workerJobs] get project for job", jobId);
  const { data: job, error: jobErr } = await admin.from("jobs").select("project_id").eq("job_id", jobId).single();
  if (jobErr) {
    console.error("[workerJobs] job lookup error", jobErr);
  }
  if (!job) return json({ error: "not found" }, 404);
  const { data: project, error: projectErr } = await admin.from("projects").select("*").eq("id", job.project_id).single();
  if (projectErr) {
    console.error("[workerJobs] project lookup error", projectErr);
  }
  if (!project) return json({ error: "project not found" }, 404);
  const { data: messages, error: msgErr } = await admin
    .from("messages")
    .select("*")
    .eq("project_id", job.project_id)
    .order("sequence_number", { ascending: true });
  if (msgErr) {
    console.error("[workerJobs] messages query error", msgErr);
  }
  const visibleMessages = (messages ?? []).filter((m: any) => typeof m.id !== "string" || !m.id.startsWith("build-error-"));
  const { data: buildsForProject, error: buildsErr } = await admin.from("builds").select("id,tasks").eq("project_id", job.project_id);
  if (buildsErr) {
    console.error("[workerJobs] builds query error", buildsErr);
  }
  const tasksByBuild: Record<string, any[]> = {};
  (buildsForProject ?? []).forEach((b: any) => {
    if (b?.id && Array.isArray(b.tasks)) tasksByBuild[b.id] = b.tasks;
  });
  const { data: versions, error: versionsErr } = await admin
    .from("builds")
    .select("version_number, artifacts")
    .eq("project_id", job.project_id)
    .eq("is_promoted", true)
    .order("version_number", { ascending: true });
  if (versionsErr) {
    console.error("[workerJobs] versions query error", versionsErr);
  }
  console.log("[workerJobs] response summary", {
    projectId: project.id,
    messages: visibleMessages.length,
    builds: (buildsForProject ?? []).length,
    versions: (versions ?? []).length,
  });
  return json({
    id: project.id,
    name: project.name,
    current_version_id: project.current_version_number,
    latest_build_id: project.latest_build_id,
    model: project.model ?? null,
    is_public: !!project.is_public,
    is_gallery: !!project.is_gallery,
    gallery_slug: project.gallery_slug ?? null,
    gallery: project.gallery ?? null,
    workspace_id: project.workspace_id ?? null,
    status: project.status ?? null,
    owner_user_id: project.owner_user_id ?? null,
    chat_history: visibleMessages.map((m: any) => ({
      ...m,
      type: m.type === "build" || m.type === "system" ? "action" : m.type,
      tasks: Array.isArray((m as any).tasks) ? (m as any).tasks : (m.build_id && tasksByBuild[m.build_id]) || [],
      attachments: m.attachments ?? null,
    })),
    versions: (versions ?? []).map((v) => ({
      id: v.version_number,
      project_id: project.id,
      created_at: null,
      web_preview_url: v.artifacts?.web ?? null,
      mobile_preview_url: v.artifacts?.mobile ?? null,
    })),
  });
}

async function handlePatchWorkerJob(req: Request, jobId: string, body: any) {
  const { service } = await getUserOrService(req, { allowServiceKey: true });
  if (!service) return json({ error: "unauthorized" }, 401);
  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (body.status) updates.status = body.status;
  if (body.result !== undefined) updates.result = body.result;
  const { error } = await admin.from("jobs").update(updates).eq("job_id", jobId);
  if (error) return json({ error: error.message }, 500);
  if (body.status && body.status === "failed") {
    const { data: jobRow } = await admin.from("jobs").select("project_id").eq("job_id", jobId).single();
    if (jobRow?.project_id) {
      await setProjectStatus(jobRow.project_id, "failed");
    }
  }
  return json({ ok: true });
}

export async function handleWorkerJobs(req: Request, segments: string[], url: URL, body: any) {
  const method = req.method.toUpperCase();
  if (segments[0] !== "worker" || segments[1] !== "jobs") return null;
  // POST /worker/jobs
  if (method === "POST" && segments.length === 2) {
    return handlePostWorkerJobs(req, body);
  }
  // GET /worker/jobs/next
  if (method === "GET" && segments[2] === "next") {
    return handleGetWorkerJobsNext(req, url);
  }
  // GET /worker/jobs
  if (method === "GET" && segments.length === 2) {
    return handleGetWorkerJobs(url);
  }
  // GET /worker/jobs/{id}
  if (method === "GET" && segments.length === 3) {
    return handleGetWorkerJob(req, segments[2]);
  }
  // POST /worker/jobs/{id}/heartbeat
  if (method === "POST" && segments[3] === "heartbeat") {
    return handlePostWorkerJobHeartbeat(req, segments[2], body);
  }
  // GET /worker/jobs/{id}/project
  if (method === "GET" && segments[3] === "project") {
    return handleGetWorkerJobProject(req, segments[2]);
  }
  // PATCH /worker/jobs/{id}
  if (method === "PATCH" && segments.length === 3) {
    return handlePatchWorkerJob(req, segments[2], body);
  }
  return null;
}
