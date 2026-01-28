import { json } from "../lib/response.ts";
import { admin, defaultAgentVersion } from "../lib/env.ts";
import { getUserOrService } from "../lib/auth.ts";
import { ensureProject, isProModel, setProjectStatus, validateModelStub } from "../lib/project.ts";
import { callLLM } from "../lib/llm.ts";
import { startVm } from "../lib/vm.ts";
import { upsertSystemMessage } from "../lib/messages.ts";

const MAX_STAGED_BUILDS = 3;

async function generateTitleFromPrompt(prompt: string): Promise<string | null> {
  try {
    const response = await callLLM(
      [
        { role: "system", content: "generate a short 3-4 word title for this app idea. return only the title, nothing else. be concise and descriptive." },
        { role: "user", content: prompt },
      ],
      { temperature: 0.7, maxTokens: 20 }
    );
    if (response.content) {
      const finalTitle = response.content.split(/\s+/).slice(0, 4).join(" ");
      return finalTitle;
    }
  } catch (err) {
    console.error("failed to generate title", err);
  }
  return null;
}

async function getActiveBuildChain(projectId: string) {
  /**
   * Fetches the active build and any staged (pending with dependency) builds.
   */
  const { data: builds } = await admin
    .from("builds")
    .select("id, status, depends_on_build_id, created_at")
    .eq("project_id", projectId)
    .in("status", ["pending", "queued", "running"])
    .order("created_at", { ascending: true });
  if (!builds || builds.length === 0) return { activeBuild: null, stagedBuilds: [] };
  // active build = pending/queued/running WITHOUT depends_on_build_id
  const activeBuild = builds.find((b: any) => !b.depends_on_build_id) ?? null;
  // staged builds = pending WITH depends_on_build_id
  const stagedBuilds = builds.filter((b: any) => b.status === "pending" && b.depends_on_build_id);
  return { activeBuild, stagedBuilds };
}

async function handlePostChat(req: Request, body: any) {
  const { user } = await getUserOrService(req);
  if (!user) return json({ error: "unauthorized" }, 401);
  const projectId = body.project_id?.toString();
  const messageRaw = body.message ?? body.content ?? "";
  const message = typeof messageRaw === "string" ? messageRaw.trim() : "";
  const model = validateModelStub(body.model);
  if (!projectId) return json({ error: "project_id required" }, 400);
  if (!message) return json({ error: "message required" }, 400);
  if (!model) return json({ error: "model required or invalid" }, 400);
  const { data: subscription, error: subscriptionError } = await admin
    .from("user_subscriptions")
    .select("plan_key")
    .eq("user_id", user.id)
    .maybeSingle();
  if (subscriptionError) {
    console.error("[chat] subscription lookup error", subscriptionError);
  }
  const planKey = subscription?.plan_key ?? "free";
  if (planKey === "free" && isProModel(model)) {
    return json({ error: "model_requires_plan", message: "Upgrade required for this model." }, 403);
  }
  const messageId = (body.message_id ?? crypto.randomUUID()).toString();
  const buildId = `build-${Date.now()}`;
  const messageModel = model;
  const userId = user.id;
  await ensureProject(projectId, user.id);
  const { data: projectRow, error: projectErr } = await admin
    .from("projects")
    .select("current_version_number, workspace_id")
    .eq("id", projectId)
    .single();
  if (projectErr) {
    console.error("[chat] project lookup error", projectErr);
  }
  const nextVersionNumber = (Number((projectRow as any)?.current_version_number ?? 0) || 0) + 1;
  const buildWorkspaceId = body.workspace_id ?? (projectRow as any)?.workspace_id ?? null;
  // check build chain status - active build or staging builds
  const { activeBuild, stagedBuilds } = await getActiveBuildChain(projectId);
  // check if last completed build failed - prevent new messages until resolved
  const { data: lastBuild } = await admin
    .from("builds")
    .select("id, status, metadata, error_code, error_message, depends_on_build_id")
    .eq("project_id", projectId)
    .order("created_at", { ascending: false })
    .limit(1)
    .single();
  if (lastBuild?.status === "failed") {
    const errorCode = (lastBuild as any)?.error_code ?? (lastBuild.metadata as any)?.error;
    const errorMessage = (lastBuild as any)?.error_message ?? null;
    return json({
      error: "build_failed",
      message: "Previous build failed. Please retry or resolve the issue before sending new messages.",
      last_build_id: lastBuild.id,
      error_code: errorCode,
      error_message: errorMessage,
    }, 400);
  }
  // determine if this should be a staged build
  const shouldStage = activeBuild !== null || stagedBuilds.length > 0;
  if (shouldStage && stagedBuilds.length >= MAX_STAGED_BUILDS) {
    return json({
      error: "max_staged_builds",
      message: `Maximum of ${MAX_STAGED_BUILDS} follow-up messages can be queued.`,
      staged_count: stagedBuilds.length,
    }, 409);
  }
  // find the build this should depend on (last in chain)
  const dependsOnBuildId = shouldStage
    ? (stagedBuilds.length > 0 ? stagedBuilds[stagedBuilds.length - 1].id : activeBuild?.id)
    : null;
  // auto-generate project name on first message
  const { data: existingUserMessages } = await admin
    .from("messages")
    .select("id")
    .eq("project_id", projectId)
    .eq("type", "user")
    .limit(1);
  const isFirstUserMessage = !existingUserMessages || existingUserMessages.length === 0;
  let updatedProjectName: string | null = null;
  if (isFirstUserMessage) {
    const { data: project } = await admin.from("projects").select("name").eq("id", projectId).single();
    const projectName = project?.name;
    if (projectName === "New Project" || projectName?.trim() === "New Project") {
      const generatedTitle = await generateTitleFromPrompt(message);
      if (generatedTitle && generatedTitle.trim()) {
        const { error: updateError } = await admin.from("projects").update({ name: generatedTitle.trim() }).eq("id", projectId);
        if (!updateError) {
          updatedProjectName = generatedTitle.trim();
        }
      }
    }
  }
  // create message
  const { error: msgErr } = await admin
    .from("messages")
    .upsert(
      {
        id: messageId,
        project_id: projectId,
        job_id: body.job_id ?? null,
        type: "user",
        content: message,
        metadata: null,
        attachments: body.attachments ?? null,
        model: messageModel,
        user_id: userId,
      },
      { onConflict: "id" },
    );
  if (msgErr) {
    if (msgErr.message?.includes("ON CONFLICT")) {
      const { error: insertErr } = await admin
        .from("messages")
        .insert(
          {
            id: messageId,
            project_id: projectId,
            job_id: body.job_id ?? null,
            type: "user",
            content: message,
            metadata: null,
            attachments: body.attachments ?? null,
            model: messageModel,
            user_id: userId,
          },
        );
      if (!insertErr) {
        console.warn("[chat] message upsert failed, fallback insert succeeded", { projectId, messageId });
      } else {
        console.error("[chat] insert message error", { projectId, messageId, error: insertErr });
        return json({ error: insertErr.message }, 500);
      }
    } else {
      console.error("[chat] insert message error", { projectId, messageId, error: msgErr });
      return json({ error: msgErr.message }, 500);
    }
  }
  // enable services from attachments
  if (body.attachments?.services && Array.isArray(body.attachments.services)) {
    for (const service of body.attachments.services) {
      if (service.stub) {
        const { error: serviceError } = await admin
          .from("project_services")
          .upsert(
            { project_id: projectId, service_stub: service.stub, config: service.config || null },
            { onConflict: "project_id,service_stub" }
          );
        if (serviceError) {
          console.error("error enabling service:", service.stub, serviceError);
        }
      }
    }
  }
  // create build - always starts as pending, with depends_on if staged
  const buildMetadata = {
    message_id: messageId,
    retry_count: 0,
    content: message,
    attachments: body.attachments ?? null,
  };
  const { error: buildErr } = await admin.from("builds").insert({
    id: buildId,
    project_id: projectId,
    version_number: nextVersionNumber,
    status: "pending",
    metadata: buildMetadata,
    model: messageModel,
    agent_version: defaultAgentVersion,
    workspace_id: buildWorkspaceId,
    error_code: null,
    error_message: null,
    retry_of_build_id: null,
    depends_on_build_id: dependsOnBuildId,
  });
  if (buildErr) return json({ error: buildErr.message }, 500);
  // for staged builds (has dependency), return early without creating a job
  if (shouldStage) {
    return json({
      ok: true,
      staged: true,
      message: { id: messageId, project_id: projectId, content: message },
      build: { id: buildId, status: "pending", depends_on_build_id: dependsOnBuildId, agent_version: defaultAgentVersion },
      project_name: updatedProjectName,
    });
  }
  // update project's latest build (only for non-staged builds)
  await admin.from("projects").update({ latest_build_id: buildId }).eq("id", projectId);
  // hard-block starting builds when user has 0 credits (API enforcement)
  const { data: balanceRow, error: balanceErr } = await admin
    .from("credit_balances")
    .select("balance")
    .eq("user_id", user.id)
    .maybeSingle();
  if (balanceErr) {
    console.error("[chat] credit balance lookup error", balanceErr);
    return json({ error: "balance_lookup_failed" }, 500);
  }
  const balance = balanceRow?.balance ?? 0;
  if (balance <= 0) {
    await admin.from("builds").update({
      status: "failed",
      error_code: "insufficient_balance",
      error_message: "insufficient credits",
      ended_at: new Date().toISOString(),
    }).eq("id", buildId);
    await setProjectStatus(projectId, "failed");
    return json({ error: "insufficient_balance", build: { id: buildId, status: "failed" }, balance }, 402);
  }
  const acquiringMessageId = `vm-acquiring-${buildId}`;
  const acquiringErr = await upsertSystemMessage({
    id: acquiringMessageId,
    projectId,
    buildId,
    content: "Acquiring agent VM...",
  });
  if (acquiringErr) {
    console.warn("[chat] failed to insert VM acquiring message", { projectId, buildId, error: acquiringErr.message });
  }
  // start vm build
  try {
    const { vm } = await startVm({
      projectId,
      mode: "building",
      buildId,
      agentType: defaultAgentVersion,
    });
    const acquiredMessageId = `vm-acquired-${buildId}`;
    const acquiredErr = await upsertSystemMessage({
      id: acquiredMessageId,
      projectId,
      buildId,
      content: "...Agent VM acquired",
    });
    if (acquiredErr) {
      console.warn("[chat] failed to insert VM acquired message", { projectId, buildId, error: acquiredErr.message });
    }
    // update build to queued
    await admin.from("builds").update({ status: "queued" }).eq("id", buildId);
    await setProjectStatus(projectId, "building");
    return json({
      ok: true,
      message: { id: messageId, project_id: projectId, content: message },
      build: { id: buildId, status: "queued", agent_version: defaultAgentVersion },
      vm: { id: vm.id, mode: vm.mode, runtime_state: vm.runtime_state },
      project_name: updatedProjectName,
    });
  } catch (err) {
    // mark build as failed
    const errorMsg = (err as Error).message;
    await admin.from("builds").update({
      status: "failed",
      error_code: "worker_error",
      error_message: errorMsg,
      metadata: { message_id: messageId, retry_count: 0 },
      ended_at: new Date().toISOString(),
    }).eq("id", buildId);
    return json({ error: errorMsg, build: { id: buildId, status: "failed" } }, 500);
  }
}

export async function handleChat(
    req: Request,
    segments: string[],
    _url: URL,
    body: any
) {
  const method = req.method.toUpperCase();
  if (segments[0] !== "chat") return null;
  // POST /chat
  if (method === "POST") {
    return handlePostChat(req, body);
  }
  return null;
}
