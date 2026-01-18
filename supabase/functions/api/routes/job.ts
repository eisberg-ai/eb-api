import { admin } from "../lib/env.ts";
import { ensureProject, setProjectStatus } from "../lib/project.ts";

type QueueJobArgs = {
  projectId: string;
  buildId: string;
  jobId?: string;
  model?: string | null;
  workspaceId?: string | null;
  payload?: unknown;
  ownerUserId?: string | null;
};

export type QueuedJob = {
  job_id: string;
  build_id: string;
  project_id: string;
  model: string | null;
  workspace_id: string | null;
};

export async function queueJob(args: QueueJobArgs): Promise<QueuedJob> {
  const jobId = (args.jobId ?? `job-${Date.now()}`).toString();
  const projectId = args.projectId.toString();
  const buildId = args.buildId;
  await ensureProject(projectId, args.ownerUserId ?? undefined);
  const model = args.model ?? null;
  // create job
  const { error } = await admin.from("jobs").insert({
    job_id: jobId,
    project_id: projectId,
    status: "queued",
    payload: args.payload ?? null,
    model,
    workspace_id: args.workspaceId ?? null,
  });
  if (error) throw new Error(error.message);
  // link build to job
  await admin.from("builds").update({ job_id: jobId }).eq("id", buildId);
  await setProjectStatus(projectId, "building");
  return { job_id: jobId, build_id: buildId, project_id: projectId, model, workspace_id: args.workspaceId ?? null };
}

export async function nextJob(projectId?: string, workerId?: string | null) {
  const { data, error } = await admin.rpc("claim_next_job", {
    p_project_id: projectId ?? null,
    p_worker_id: workerId ?? null,
  });
  if (error) {
    console.error("nextJob claim_next_job error", error);
    return null;
  }
  if (!data || !data.length) return null;
  return data[0];
}
