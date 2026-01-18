import { json } from "../lib/response.ts";
import { admin } from "../lib/env.ts";
import { getUserOrService } from "../lib/auth.ts";
import { queueJob } from "./job.ts";
import { ensureProject, isProModel, setProjectStatus, validateModelStub } from "../lib/project.ts";
import { callLLM } from "../lib/llm.ts";

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
  // check if last build failed - prevent new messages until resolved
  const { data: lastBuild } = await admin
    .from("builds")
    .select("id, status, metadata, error_code, error_message")
    .eq("project_id", projectId)
    .order("created_at", { ascending: false })
    .limit(1)
    .single();
  if (lastBuild?.status && ["pending", "queued", "running"].includes(lastBuild.status)) {
    return json({
      error: "build_in_progress",
      message: "A build is currently in progress. Please wait for it to finish before sending new messages.",
      last_build_id: lastBuild.id,
      status: lastBuild.status,
    }, 409);
  }
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
    console.error("[chat] insert message error", { projectId, messageId, error: msgErr });
    return json({ error: msgErr.message }, 500);
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
  // create build with pending status
  const { error: buildErr } = await admin.from("builds").insert({
    id: buildId,
    project_id: projectId,
    version_number: nextVersionNumber,
    status: "pending",
    metadata: { message_id: messageId, retry_count: 0 },
    model: messageModel,
    workspace_id: buildWorkspaceId,
    error_code: null,
    error_message: null,
    retry_of_build_id: null,
  });
  if (buildErr) return json({ error: buildErr.message }, 500);
  // update project's latest build
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
  // queue job
  try {
    const job = await queueJob({
      projectId,
      buildId,
      jobId: body.job_id,
      model: messageModel ?? null,
      workspaceId: body.workspace_id ?? null,
      payload: body.payload ?? { message_id: messageId, content: message, attachments: body.attachments ?? null },
      ownerUserId: user.id,
    });
    // update build to queued
    await admin.from("builds").update({ status: "queued" }).eq("id", buildId);
    return json({
      ok: true,
      message: { id: messageId, project_id: projectId, content: message },
      build: { id: buildId, status: "queued" },
      job,
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
