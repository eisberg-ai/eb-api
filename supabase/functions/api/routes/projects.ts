import { json } from "../lib/response.ts";
import { admin } from "../lib/env.ts";
import { getUserOrService } from "../lib/auth.ts";
import { ensureProject, getCurrentWorkspaceId, DEFAULT_MODEL, isProModel, normalizeProjectStatus, validateModelStub } from "../lib/project.ts";
import { callLLM } from "../lib/llm.ts";
import { getServicesRegistry } from "../lib/registry.ts";

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

async function handleGetVersions(req: Request, segments: string[], url: URL) {
  const { user } = await getUserOrService(req);
  if (!user) return json({ error: "unauthorized" }, 401);
  const projectId = url.searchParams.get("projectId") || segments[2];
  if (!projectId) return json({ error: "projectId required" }, 400);
  const { data: builds } = await admin
    .from("builds")
    .select("id, version_number, created_at, artifacts, is_promoted, status")
    .eq("project_id", projectId)
    .order("created_at", { ascending: false });
  const { data: project } = await admin.from("projects").select("current_version_number").eq("id", projectId).single();
  const { data: messages } = await admin
    .from("messages")
    .select("id, type, content, created_at")
    .eq("project_id", projectId)
    .order("created_at", { ascending: true });
  const buildsWithMessages = (builds ?? []).map((b: any) => {
    const buildCreatedAt = new Date(b.created_at);
    const buildMessages = (messages ?? []).filter((m: any) => new Date(m.created_at) <= buildCreatedAt);
    const lastUserMessage = [...buildMessages].reverse().find((m: any) => m.type === "user");
    return {
      build_id: b.id,
      version_number: b.version_number,
      is_promoted: b.is_promoted ?? false,
      status: b.status ?? null,
      created_at: b.created_at,
      description: lastUserMessage?.content || `Build ${b.id.slice(0, 8)}`,
      web_preview_url: b.artifacts?.web ?? null,
      mobile_preview_url: b.artifacts?.mobile ?? null,
    };
  });
  return json({ versions: buildsWithMessages, current_version_id: project?.current_version_number ?? null });
}

async function handleGetEnvVars(req: Request, projectId: string) {
  const auth = await getUserOrService(req, { allowServiceKey: true });
  const user = auth.user;
  const isService = auth.service;
  if (!user && !isService) return json({ error: "unauthorized" }, 401);
  const { data: project } = await admin.from("projects").select("owner_user_id").eq("id", projectId).single();
  if (!project) return json({ error: "not found" }, 404);
  if (!isService) {
    const { data: memberRows } = await admin
      .from("project_members")
      .select("user_id")
      .eq("project_id", projectId)
      .eq("user_id", user!.id)
      .limit(1);
    const isOwner = project.owner_user_id === user!.id;
    const isMember = (memberRows ?? []).length > 0;
    if (!isOwner && !isMember) return json({ error: "forbidden" }, 403);
  }
  const { data, error } = await admin
    .from("env_vars")
    .select("id, service, key, value, created_at")
    .eq("project_id", projectId)
    .order("created_at", { ascending: true });
  if (error) return json({ error: error.message }, 500);
  return json({ envVars: data ?? [] });
}

async function handlePostEnvVar(req: Request, projectId: string, body: any) {
  const auth = await getUserOrService(req, { allowServiceKey: true });
  const user = auth.user;
  const isService = auth.service;
  if (!user && !isService) return json({ error: "unauthorized" }, 401);
  const { data: project } = await admin.from("projects").select("owner_user_id").eq("id", projectId).single();
  if (!project) return json({ error: "not found" }, 404);
  if (!isService) {
    const { data: memberRows } = await admin
      .from("project_members")
      .select("user_id")
      .eq("project_id", projectId)
      .eq("user_id", user!.id)
      .limit(1);
    const isOwner = project.owner_user_id === user!.id;
    const isMember = (memberRows ?? []).length > 0;
    if (!isOwner && !isMember) return json({ error: "forbidden" }, 403);
  }
  const { key, value, service } = body || {};
  if (!key || !value || !service) return json({ error: "key, value, service required" }, 400);
  const { data, error } = await admin
    .from("env_vars")
    .insert({ project_id: projectId, key, value, service })
    .select("id, service, key, value, created_at")
    .single();
  if (error) return json({ error: error.message }, 500);
  return json({ envVar: data });
}

async function handleDeleteEnvVar(req: Request, projectId: string, body: any) {
  const auth = await getUserOrService(req, { allowServiceKey: true });
  const user = auth.user;
  const isService = auth.service;
  if (!user && !isService) return json({ error: "unauthorized" }, 401);
  const { data: project } = await admin.from("projects").select("owner_user_id").eq("id", projectId).single();
  if (!project) return json({ error: "not found" }, 404);
  if (!isService) {
    const { data: memberRows } = await admin
      .from("project_members")
      .select("user_id")
      .eq("project_id", projectId)
      .eq("user_id", user!.id)
      .limit(1);
    const isOwner = project.owner_user_id === user!.id;
    const isMember = (memberRows ?? []).length > 0;
    if (!isOwner && !isMember) return json({ error: "forbidden" }, 403);
  }
  const { id } = body || {};
  if (!id) return json({ error: "id required" }, 400);
  const { error } = await admin.from("env_vars").delete().eq("id", id).eq("project_id", projectId);
  if (error) return json({ error: error.message }, 500);
  return json({ success: true });
}

const ALLOWED_SERVICE_STUBS = new Set(
  Object.values(getServicesRegistry()).flat().map((service) => service.stub),
);

async function handleGetProjectServices(req: Request, projectId: string) {
  const auth = await getUserOrService(req, { allowServiceKey: true });
  const user = auth.user;
  const isService = auth.service;
  if (!user && !isService) return json({ error: "unauthorized" }, 401);
  const { data: project } = await admin.from("projects").select("owner_user_id").eq("id", projectId).single();
  if (!project) return json({ error: "not found" }, 404);
  if (!isService && user && project.owner_user_id !== user.id) return json({ error: "forbidden" }, 403);
  const { data, error } = await admin
    .from("project_services")
    .select("service_stub, config")
    .eq("project_id", projectId);
  if (error) return json({ error: error.message }, 500);
  const services = (data ?? []).map((row: any) => ({
    stub: row.service_stub,
    config: row.config ?? null,
  }));
  return json({ services });
}

async function handlePostProjectService(req: Request, projectId: string, body: any) {
  const auth = await getUserOrService(req, { allowServiceKey: true });
  const user = auth.user;
  const isService = auth.service;
  if (!user && !isService) return json({ error: "unauthorized" }, 401);
  const { data: project } = await admin.from("projects").select("owner_user_id").eq("id", projectId).single();
  if (!project) return json({ error: "not found" }, 404);
  if (!isService && user && project.owner_user_id !== user.id) return json({ error: "forbidden" }, 403);
  const stub = body?.serviceStub ?? body?.service_stub ?? body?.stub;
  if (!stub || typeof stub !== "string") return json({ error: "serviceStub required" }, 400);
  if (!ALLOWED_SERVICE_STUBS.has(stub)) return json({ error: "unknown service stub" }, 400);
  const config = body?.config ?? null;
  const { error } = await admin
    .from("project_services")
    .upsert({ project_id: projectId, service_stub: stub, config }, { onConflict: "project_id,service_stub" });
  if (error) return json({ error: error.message }, 500);
  return json({ ok: true });
}

async function handleDeleteProjectService(req: Request, projectId: string, serviceStub: string) {
  const auth = await getUserOrService(req, { allowServiceKey: true });
  const user = auth.user;
  const isService = auth.service;
  if (!user && !isService) return json({ error: "unauthorized" }, 401);
  const { data: project } = await admin.from("projects").select("owner_user_id").eq("id", projectId).single();
  if (!project) return json({ error: "not found" }, 404);
  if (!isService && user && project.owner_user_id !== user.id) return json({ error: "forbidden" }, 403);
  const stub = serviceStub?.toString();
  if (!stub) return json({ error: "serviceStub required" }, 400);
  const { error } = await admin
    .from("project_services")
    .delete()
    .eq("project_id", projectId)
    .eq("service_stub", stub);
  if (error) return json({ error: error.message }, 500);
  return json({ ok: true });
}

async function handleGetVersionSource(projectId: string, versionId: number) {
  const { data: build } = await admin
    .from("builds")
    .select("source, source_encoding")
    .eq("project_id", projectId)
    .eq("version_number", versionId)
    .eq("is_promoted", true)
    .single();
  if (!build) return json({ error: "Version not found" }, 404);
  return json({ source_code: build.source || null, encoding: build.source_encoding || "base64" });
}

async function handlePostVersionSource(projectId: string, versionId: number, body: any) {
  const source = body?.source as string | undefined;
  const encoding = (body?.encoding as string | undefined) || "r2";
  if (!source) return json({ error: "source is required" }, 400);
  const { data: build } = await admin
    .from("builds")
    .select("id")
    .eq("project_id", projectId)
    .eq("version_number", versionId)
    .single();
  if (build) {
    await admin.from("builds").update({ source, source_encoding: encoding }).eq("id", build.id);
  } else {
    await admin.from("builds").insert({
      id: `build-${projectId}-${versionId}`,
      project_id: projectId,
      version_number: versionId,
      status: "succeeded",
      is_promoted: true,
      source,
      source_encoding: encoding,
    });
  }
  return json({ ok: true });
}

async function handleGetChat(projectId: string) {
  const { data, error } = await admin.from("messages").select("*").eq("project_id", projectId).order("sequence_number", { ascending: true });
  if (error) return json({ error: error.message }, 500);
  const messages = (data ?? []).map((m: any) => ({
    ...m,
  }));
  return json({ messages });
}

async function handleGetStagedBuilds(req: Request, projectId: string) {
  /**
   * Fetches staged builds (pending with depends_on_build_id) for a project.
   */
  const { user } = await getUserOrService(req);
  if (!user) return json({ error: "unauthorized" }, 401);
  // verify project ownership
  const { data: project } = await admin
    .from("projects")
    .select("owner_user_id")
    .eq("id", projectId)
    .single();
  if (!project) return json({ error: "not found" }, 404);
  if (project.owner_user_id !== user.id) return json({ error: "forbidden" }, 403);
  // staged = pending builds with depends_on_build_id set
  const { data: builds, error } = await admin
    .from("builds")
    .select("id, status, depends_on_build_id, metadata, model, created_at")
    .eq("project_id", projectId)
    .eq("status", "pending")
    .not("depends_on_build_id", "is", null)
    .order("created_at", { ascending: true });
  if (error) return json({ error: error.message }, 500);
  // map to response format with content preview
  const staged = (builds ?? []).map((b: any) => {
    const meta = (b.metadata as Record<string, any>) ?? {};
    return {
      id: b.id,
      depends_on_build_id: b.depends_on_build_id,
      content: meta.content ?? null,
      attachments: meta.attachments ?? null,
      model: b.model,
      created_at: b.created_at,
    };
  });
  return json({ staged_builds: staged });
}

async function handlePostMessage(req: Request, projectId: string, body: any) {
  const auth = await getUserOrService(req, { allowServiceKey: true });
  await ensureProject(projectId);
  const message = body || {};
  const model = validateModelStub(message.model);
  if (!model) return json({ error: "model required or invalid" }, 400);
  const authedUserId = auth.user?.id ?? null;
  const msgPayload = {
    id: message.id,
    project_id: projectId,
    job_id: message.job_id ?? message.jobId ?? null,
    build_id: message.build_id ?? message.buildId ?? null,
    type: message.type,
    content: message.content ?? null,
    metadata: message.metadata ?? null,
    attachments: message.attachments ?? null,
    created_at: message.created_at ?? message.createdAt ?? null,
    model,
    user_id: message.type === "user" ? (authedUserId ?? message.user_id ?? message.userId ?? null) : null,
  };
  const isUserMessage = msgPayload.type === "user" && msgPayload.content;
  let updatedProjectName: string | null = null;
  if (isUserMessage) {
    const { data: existingUserMessages, error: queryError } = await admin
      .from("messages")
      .select("id")
      .eq("project_id", projectId)
      .eq("type", "user")
      .limit(1);
    if (queryError) {
      console.error("error checking existing messages:", queryError);
    }
    const isFirstUserMessage = !existingUserMessages || existingUserMessages.length === 0;
    if (isFirstUserMessage) {
      const { data: project, error: projectError } = await admin.from("projects").select("name,status").eq("id", projectId).single();
      if (projectError) {
        console.error("error fetching project:", projectError);
      }
      const projectName = project?.name;
      const updateFields: Record<string, unknown> = {};
      if (!projectName || projectName === "New Project" || projectName.trim() === "New Project") {
        try {
          const generatedTitle = await generateTitleFromPrompt(msgPayload.content);
          if (generatedTitle && generatedTitle.trim()) {
            updateFields.name = generatedTitle.trim();
            updatedProjectName = generatedTitle.trim();
          }
        } catch (err) {
          console.error("exception during title generation:", err);
        }
      }
      if (project?.status === "staged") {
        updateFields.status = "active";
      }
      if (Object.keys(updateFields).length > 0) {
        const { error: updateError } = await admin
          .from("projects")
          .update({ ...updateFields, updated_at: new Date().toISOString() })
          .eq("id", projectId);
        if (updateError) {
          console.error("error updating project:", updateError);
        }
      }
    }
  }
  const { error } = await admin.from("messages").upsert(msgPayload, { onConflict: "id" });
  if (error) {
    console.error("[projects] insert message error", { projectId, msgPayload, error });
    return json({ error: error.message }, 500);
  }
  return json({ ok: true, message: msgPayload, projectName: updatedProjectName });
}

async function fetchProjectsForUser(userId: string, includeDrafts: boolean) {
  const { data: ownedProjects, error: ownedErr } = await admin
    .from("projects")
    .select("id, name, owner_user_id, current_version_number, latest_build_id, created_at, updated_at, model, is_public, workspace_id, status")
    .eq("owner_user_id", userId);
  if (ownedErr) {
    console.error("[projects] ownedProjects error", ownedErr);
  }
  const memberProjects: any[] = [];
  // also include any projects where the user has authored messages (backfill for legacy rows missing ownership)
  const { data: authoredMessageProjectIds, error: authoredMsgErr } = await admin
    .from("messages")
    .select("project_id")
    .eq("user_id", userId);
  if (authoredMsgErr) {
    console.error("[projects] authoredMessageProjectIds error", authoredMsgErr);
  }
  const authoredIds = Array.from(new Set((authoredMessageProjectIds ?? []).map((m: any) => m.project_id).filter(Boolean)));
  const { data: authoredProjects, error: authoredProjectsErr } = authoredIds.length > 0
    ? await admin
        .from("projects")
        .select("id, name, owner_user_id, current_version_number, latest_build_id, created_at, updated_at, model, is_public, workspace_id, status")
        .in("id", authoredIds)
    : { data: [] as any[] };
  if (authoredProjectsErr) {
    console.error("[projects] authoredProjects error", authoredProjectsErr);
  }
  const allProjects = [...(ownedProjects ?? []), ...(memberProjects ?? []), ...(authoredProjects ?? [])];
  console.log("[projects] handleGetProjects result counts", {
    owned: ownedProjects?.length ?? 0,
    member: memberProjects?.length ?? 0,
    authored: authoredProjects?.length ?? 0,
    total: allProjects.length,
  });
  const uniqueProjects = Array.from(new Map(allProjects.map((p: any) => [p.id, p])).values()) as any[];
  const visibleProjects = includeDrafts ? uniqueProjects : uniqueProjects.filter((p: any) => p.status !== "draft");
  visibleProjects.sort((a, b) => {
    const aTime = a.updated_at ? new Date(a.updated_at).getTime() : 0;
    const bTime = b.updated_at ? new Date(b.updated_at).getTime() : 0;
    return bTime - aTime;
  });
  return visibleProjects.map((p: any) => ({
    id: p.id,
    title: p.name || "New Project",
    description: "",
    updated_at: p.updated_at ?? null,
    created_at: p.created_at ?? null,
    last_edited: p.updated_at ? new Date(p.updated_at).toLocaleDateString() : "never",
    model: (p.model as string | undefined) || null,
    is_public: !!p.is_public,
    workspace_id: p.workspace_id ?? null,
    status: (p.status as string | undefined) ?? null,
    current_version_id: p.current_version_number ?? null,
  }));
}

async function handleGetProjects(req: Request, url: URL) {
  const auth = await getUserOrService(req, { allowServiceKey: true });
  let userId = auth.user?.id ?? null;
  if (auth.service && !userId) {
    userId = req.headers.get("x-user-id") ?? req.headers.get("X-User-Id") ?? null;
  }
  if (!userId) return json({ error: "unauthorized" }, 401);
  const includeDrafts = ["1", "true"].includes((url.searchParams.get("include_drafts") || "").toLowerCase());
  console.log("[projects] handleGetProjects start", { userId, service: auth.service, includeDrafts });
  const projectsWithMetadata = await fetchProjectsForUser(userId, includeDrafts);
  return json({ projects: projectsWithMetadata });
}

function serializeBuild(build: any) {
  if (!build) return null;
  return {
    id: build.id,
    project_id: build.project_id,
    job_id: build.job_id,
    version_id: build.version_number,
    status: build.status,
    tasks: build.tasks ?? [],
    artifacts: build.artifacts ?? null,
    metadata: build.metadata ?? null,
    started_at: build.started_at,
    ended_at: build.ended_at,
    model: build.model,
    agent_version: build.agent_version,
    workspace_id: build.workspace_id,
    error_code: build.error_code ?? null,
    error_message: build.error_message ?? null,
    retry_of_build_id: build.retry_of_build_id ?? null,
  };
}

async function buildProjectPayload(projectId: string, userId?: string) {
  let { data: project } = await admin.from("projects").select("*").eq("id", projectId).single();
  if (!project) {
    if (!userId) return null;
    await ensureProject(projectId, userId);
    const { data: newProject } = await admin.from("projects").select("*").eq("id", projectId).single();
    if (!newProject) return null;
    project = newProject;
  }
  const { data: messages } = await admin
    .from("messages")
    .select("*")
    .eq("project_id", projectId)
    .order("sequence_number", { ascending: true });
  const visibleMessages = (messages ?? []).filter((m: any) => typeof m.id !== "string" || !m.id.startsWith("build-error-"));
  const { data: buildsForProject } = await admin.from("builds").select("id,tasks").eq("project_id", projectId);
  const tasksByBuild: Record<string, any[]> = {};
  (buildsForProject ?? []).forEach((b: any) => {
    if (b?.id && Array.isArray(b.tasks)) tasksByBuild[b.id] = b.tasks;
  });
  const { data: versions } = await admin
    .from("builds")
    .select("version_number, artifacts")
    .eq("project_id", projectId)
    .eq("is_promoted", true)
    .order("version_number", { ascending: true });
  const { data: envVars } = await admin
    .from("env_vars")
    .select("id, service, key, created_at")
    .eq("project_id", projectId)
    .order("created_at", { ascending: true });
  return {
    id: project.id,
    name: project.name,
    updated_at: project.updated_at ?? null,
    current_version_id: project.current_version_number,
    latest_build_id: project.latest_build_id,
    status: project.status ?? null,
    chat_history: visibleMessages.map((m: any) => ({
      ...m,
      type: m.type === "build" || m.type === "system" ? "action" : m.type,
      tasks: Array.isArray((m as any).tasks) ? (m as any).tasks : (m.build_id && tasksByBuild[m.build_id]) || [],
    })),
    env_vars: envVars ?? [],
    versions: (versions ?? []).map((v) => ({
      id: v.version_number,
      project_id: project.id,
      created_at: null,
      web_preview_url: v.artifacts?.web ?? null,
      mobile_preview_url: v.artifacts?.mobile ?? null,
    })),
    model: project.model ?? null,
    is_public: !!project.is_public,
    is_gallery: !!project.is_gallery,
    gallery_slug: project.gallery_slug ?? null,
    gallery: project.gallery ?? null,
    workspace_id: project.workspace_id ?? null,
    status: project.status ?? null,
  };
}

async function resolveUserIdForStream(req: Request, url: URL) {
  const auth = await getUserOrService(req, { allowServiceKey: true });
  let userId = auth.user?.id ?? null;
  if (auth.service && !userId) {
    userId = req.headers.get("x-user-id") ?? req.headers.get("X-User-Id") ?? null;
  }
  const accessToken = url.searchParams.get("access_token");
  if (!userId && accessToken) {
    try {
      const parts = accessToken.split(".");
      if (parts.length === 3) {
        const payload = JSON.parse(atob(parts[1]));
        if (payload?.sub) {
          userId = payload.sub;
        }
      }
    } catch (_e) {
      // ignore
    }
    if (!userId) {
      const { data: { user } } = await admin.auth.getUser(accessToken);
      if (user?.id) {
        userId = user.id;
      }
    }
  }
  return userId;
}

async function handleGetProjectsStream(req: Request, url: URL) {
  const userId = await resolveUserIdForStream(req, url);
  if (!userId) return json({ error: "unauthorized" }, 401);
  const includeDrafts = ["1", "true"].includes((url.searchParams.get("include_drafts") || "").toLowerCase());
  const pollMsRaw = Number(url.searchParams.get("poll_ms") ?? "5000");
  const pollMs = Number.isFinite(pollMsRaw) ? Math.min(20000, Math.max(2000, pollMsRaw)) : 5000;
  const encoder = new TextEncoder();
  let lastPayload = "";
  const signal = req.signal;
  const stream = new ReadableStream({
    start(controller) {
      const send = (event: string, data: string) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${data}\n\n`));
      };
      const sendComment = (text: string) => {
        controller.enqueue(encoder.encode(`: ${text}\n\n`));
      };
      sendComment("connected");
      const loop = async () => {
        while (!signal.aborted) {
          try {
            const projects = await fetchProjectsForUser(userId, includeDrafts);
            const payload = JSON.stringify({ projects });
            if (payload !== lastPayload) {
              send("projects", payload);
              lastPayload = payload;
            }
          } catch (err) {
            console.error("[projects] stream error", err);
            send("error", JSON.stringify({ message: (err as Error).message }));
          }
          await new Promise((resolve) => setTimeout(resolve, pollMs));
        }
        controller.close();
      };
      loop().catch((err) => {
        console.error("[projects] stream loop failed", err);
        controller.close();
      });
    },
    cancel() {
      // noop
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

async function handleGetProjectStream(req: Request, url: URL, projectId: string) {
  const userId = await resolveUserIdForStream(req, url);
  if (!userId) return json({ error: "unauthorized" }, 401);
  const pollMsRaw = Number(url.searchParams.get("poll_ms") ?? "4000");
  const pollMs = Number.isFinite(pollMsRaw) ? Math.min(20000, Math.max(2000, pollMsRaw)) : 4000;
  const encoder = new TextEncoder();
  let lastPayload = "";
  const signal = req.signal;
  const stream = new ReadableStream({
    start(controller) {
      const send = (event: string, data: string) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${data}\n\n`));
      };
      const sendComment = (text: string) => {
        controller.enqueue(encoder.encode(`: ${text}\n\n`));
      };
      sendComment("connected");
      const loop = async () => {
        while (!signal.aborted) {
          try {
            const project = await buildProjectPayload(projectId, userId);
            if (!project) {
              send("error", JSON.stringify({ message: "not found" }));
            } else {
              let build = null;
              if (project.latest_build_id) {
                const { data: buildRow } = await admin.from("builds").select("*").eq("id", project.latest_build_id).single();
                build = serializeBuild(buildRow);
              }
              const payload = JSON.stringify({ project, build });
              if (payload !== lastPayload) {
                send("project", payload);
                lastPayload = payload;
              }
            }
          } catch (err) {
            console.error("[projects] project stream error", err);
            send("error", JSON.stringify({ message: (err as Error).message }));
          }
          await new Promise((resolve) => setTimeout(resolve, pollMs));
        }
        controller.close();
      };
      loop().catch((err) => {
        console.error("[projects] project stream loop failed", err);
        controller.close();
      });
    },
    cancel() {
      // noop
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

async function handleCleanupDraftProjects(req: Request, body: any) {
  const { user } = await getUserOrService(req);
  if (!user) return json({ error: "unauthorized" }, 401);
  const maxAgeHoursRaw = body?.max_age_hours ?? body?.maxAgeHours ?? 24;
  const maxAgeHours = Number(maxAgeHoursRaw);
  const hours = Number.isFinite(maxAgeHours) && maxAgeHours > 0 ? maxAgeHours : 24;
  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  const { data: drafts, error: draftErr } = await admin
    .from("projects")
    .select("id")
    .eq("owner_user_id", user.id)
    .eq("status", "draft")
    .lt("updated_at", cutoff);
  if (draftErr) return json({ error: draftErr.message }, 500);
  const draftIds = (drafts ?? []).map((d: any) => d.id);
  if (draftIds.length === 0) return json({ deleted: 0 });
  const { data: messageRows } = await admin.from("messages").select("project_id").in("project_id", draftIds);
  const { data: buildRows } = await admin.from("builds").select("project_id").in("project_id", draftIds);
  const protectedIds = new Set([
    ...(messageRows ?? []).map((m: any) => m.project_id),
    ...(buildRows ?? []).map((b: any) => b.project_id),
  ]);
  const deletableIds = draftIds.filter((id) => !protectedIds.has(id));
  if (deletableIds.length === 0) return json({ deleted: 0 });
  const { error: deleteErr } = await admin
    .from("projects")
    .delete()
    .in("id", deletableIds)
    .eq("owner_user_id", user.id);
  if (deleteErr) return json({ error: deleteErr.message }, 500);
  return json({ deleted: deletableIds.length });
}

async function handleGetProject(req: Request, projectId: string) {
  const { user } = await getUserOrService(req);
  if (!user) return json({ error: "unauthorized" }, 401);
  const payload = await buildProjectPayload(projectId, user.id);
  if (!payload) return json({ error: "not found" }, 404);
  return json(payload);
}

async function handlePostProject(req: Request, body: any) {
  const { user } = await getUserOrService(req);
  if (!user) return json({ error: "unauthorized" }, 401);
  const projectId = body.id || `project-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  let name = body.name || body.title || "New Project";
  // accept model from body, fall back to default
  const model = validateModelStub(body.model) ?? DEFAULT_MODEL;
  const { data: subscription, error: subscriptionError } = await admin
    .from("user_subscriptions")
    .select("plan_key")
    .eq("user_id", user.id)
    .maybeSingle();
  if (subscriptionError) {
    console.error("[projects] subscription lookup error", subscriptionError);
  }
  const planKey = subscription?.plan_key ?? "free";
  if (planKey === "free" && isProModel(model)) {
    return json({ error: "model_requires_plan", message: "Upgrade required for this model." }, 403);
  }
  const isPublic = body.is_public ?? body.isPublic ?? false;
  let workspaceId = body.workspace_id ?? body.workspaceId ?? null;
  const initialPrompt = body.initial_prompt ?? body.initialPrompt as string | undefined;
  if (name === "New Project" && initialPrompt && initialPrompt.trim()) {
    const generatedName = await generateTitleFromPrompt(initialPrompt.trim());
    if (generatedName && generatedName.trim()) {
      name = generatedName.trim();
    }
  }
  await ensureProject(projectId, user.id);
  // default to user's current workspace if not provided
  if (!workspaceId) {
    workspaceId = await getCurrentWorkspaceId(user.id);
  }
  const updateData: any = {
    updated_at: new Date().toISOString(),
    name,
    model,
    is_public: isPublic,
    workspace_id: workspaceId,
  };
  const gallerySlugRaw = body.gallery_slug ?? body.gallerySlug;
  if (gallerySlugRaw !== undefined) {
    const gallerySlug = typeof gallerySlugRaw === "string" ? gallerySlugRaw.trim() : gallerySlugRaw;
    updateData.gallery_slug = gallerySlug ? gallerySlug : null;
  }
  const isGallery = body.is_gallery ?? body.isGallery;
  if (isGallery !== undefined) {
    updateData.is_gallery = !!isGallery;
  }
  const galleryPayload = body.gallery ?? body.gallery_data ?? body.galleryData;
  const gallerySourceId = body.gallery_source_id ?? body.gallerySourceId;
  const gallerySourceSlug = body.gallery_source_slug ?? body.gallerySourceSlug;
  if (gallerySourceId || gallerySourceSlug) {
    let sourceQuery = admin
      .from("projects")
      .select("id, gallery, gallery_slug")
      .eq("is_gallery", true)
      .limit(1);
    if (gallerySourceId) {
      sourceQuery = sourceQuery.eq("id", gallerySourceId);
    } else {
      sourceQuery = sourceQuery.eq("gallery_slug", gallerySourceSlug);
    }
    const { data: source } = await sourceQuery.maybeSingle();
    if (source?.gallery && typeof source.gallery === "object") {
      updateData.gallery = {
        ...source.gallery,
        ...(galleryPayload && typeof galleryPayload === "object" ? galleryPayload : {}),
        source_project_id: source.id,
        source_slug: source.gallery_slug ?? source.id,
      };
    }
  }
  if (galleryPayload !== undefined && updateData.gallery === undefined) {
    updateData.gallery = galleryPayload;
  }
  const requestedStatus = normalizeProjectStatus(body.status ?? body.project_status ?? body.projectStatus);
  if (requestedStatus) {
    updateData.status = requestedStatus;
  } else {
    const hasInitialPrompt = typeof initialPrompt === "string" && initialPrompt.trim().length > 0;
    const isDefaultName = !name || name.trim() === "New Project";
    updateData.status = !hasInitialPrompt && isDefaultName ? "staged" : "active";
  }
  const { error: updateErr } = await admin.from("projects").update(updateData).eq("id", projectId);
  if (updateErr) return json({ error: updateErr.message }, 500);
  const { data: project } = await admin.from("projects").select("*").eq("id", projectId).single();
  if (!project) return json({ error: "failed to create project" }, 500);
  return json({
    id: project.id,
    name: project.name || null,
    title: project.name || null,
    description: "",
    last_edited: new Date().toLocaleDateString(),
    model: project.model ?? model,
    is_public: project.is_public ?? isPublic,
    workspace_id: project.workspace_id ?? workspaceId,
  });
}

async function handlePatchProject(req: Request, projectId: string, body: any) {
  const auth = await getUserOrService(req, { allowServiceKey: true });
  const user = auth.user;
  const isService = auth.service;
  if (!user && !isService) return json({ error: "unauthorized" }, 401);
  const updates: any = { updated_at: new Date().toISOString() };
  if (body.name) {
    if (body.name.trim() === "New Project") {
      return json({ error: "Cannot rename project to 'New Project'" }, 400);
    }
    updates.name = body.name;
  }
  if (body.title) {
    if (body.title.trim() === "New Project") {
      return json({ error: "Cannot rename project to 'New Project'" }, 400);
    }
    updates.name = body.title;
  }
  // accept model from body (snake or camel case)
  if (body.model) {
    const validated = validateModelStub(body.model);
    if (!validated) return json({ error: "model invalid" }, 400);
    if (user) {
      const { data: subscription, error: subscriptionError } = await admin
        .from("user_subscriptions")
        .select("plan_key")
        .eq("user_id", user.id)
        .maybeSingle();
      if (subscriptionError) {
        console.error("[projects] subscription lookup error", subscriptionError);
      }
      const planKey = subscription?.plan_key ?? "free";
      if (planKey === "free" && isProModel(validated)) {
        return json({ error: "model_requires_plan", message: "Upgrade required for this model." }, 403);
      }
    }
    updates.model = validated;
  }
  const isPublic = body.is_public ?? body.isPublic;
  if (isPublic !== undefined) updates.is_public = !!isPublic;
  const gallerySlugRaw = body.gallery_slug ?? body.gallerySlug;
  if (gallerySlugRaw !== undefined) {
    const gallerySlug = typeof gallerySlugRaw === "string" ? gallerySlugRaw.trim() : gallerySlugRaw;
    updates.gallery_slug = gallerySlug ? gallerySlug : null;
  }
  const isGallery = body.is_gallery ?? body.isGallery;
  if (isGallery !== undefined) updates.is_gallery = !!isGallery;
  const galleryPayload = body.gallery ?? body.gallery_data ?? body.galleryData;
  const gallerySourceId = body.gallery_source_id ?? body.gallerySourceId;
  const gallerySourceSlug = body.gallery_source_slug ?? body.gallerySourceSlug;
  if (gallerySourceId || gallerySourceSlug) {
    let sourceQuery = admin
      .from("projects")
      .select("id, gallery, gallery_slug")
      .eq("is_gallery", true)
      .limit(1);
    if (gallerySourceId) {
      sourceQuery = sourceQuery.eq("id", gallerySourceId);
    } else {
      sourceQuery = sourceQuery.eq("gallery_slug", gallerySourceSlug);
    }
    const { data: source } = await sourceQuery.maybeSingle();
    if (source?.gallery && typeof source.gallery === "object") {
      updates.gallery = {
        ...source.gallery,
        ...(galleryPayload && typeof galleryPayload === "object" ? galleryPayload : {}),
        source_project_id: source.id,
        source_slug: source.gallery_slug ?? source.id,
      };
    }
  }
  if (galleryPayload !== undefined && updates.gallery === undefined) {
    updates.gallery = galleryPayload;
  }
  const workspaceId = body.workspace_id ?? body.workspaceId;
  if (workspaceId !== undefined) updates.workspace_id = workspaceId;
  const requestedStatus = body.status !== undefined ? normalizeProjectStatus(body.status) : null;
  if (body.status !== undefined) {
    if (!requestedStatus) return json({ error: "status invalid" }, 400);
    updates.status = requestedStatus;
  }
  const updatedName = (body.name ?? body.title) as string | undefined;
  if (!requestedStatus && updatedName && updatedName.trim() !== "New Project") {
    const { data: project } = await admin.from("projects").select("status").eq("id", projectId).single();
    if (project?.status === "staged") {
      updates.status = "active";
    }
  }
  const currentVersionId = body.current_version_id ?? body.currentVersionId;
  if (currentVersionId !== undefined) {
    const versionNumber = Number(currentVersionId);
    const { data: build } = await admin
      .from("builds")
      .select("id")
      .eq("project_id", projectId)
      .eq("version_number", versionNumber)
      .eq("is_promoted", true)
      .single();
    if (!build) return json({ error: "Version not found" }, 404);
    updates.current_version_number = versionNumber;
    updates.latest_build_id = build.id;
  }
  // service calls can update any project; user calls require ownership
  let query = admin.from("projects").update(updates).eq("id", projectId);
  if (!isService && user) {
    query = query.eq("owner_user_id", user.id);
  }
  const { error } = await query;
  if (error) return json({ error: error.message }, 500);
  return json({ ok: true });
}

async function handleDeleteProject(req: Request, projectId: string) {
  const { user } = await getUserOrService(req);
  if (!user) return json({ error: "unauthorized" }, 401);
  const { error } = await admin.from("projects").delete().eq("id", projectId).eq("owner_user_id", user.id);
  if (error) return json({ error: error.message }, 500);
  return json({ ok: true });
}

export async function handleProjects(req: Request, segments: string[], url: URL, body: any) {
  const method = req.method.toUpperCase();
  if (segments[0] !== "projects") return null;
  // GET /projects/stream
  if (method === "GET" && segments[1] === "stream") {
    return handleGetProjectsStream(req, url);
  }
  // GET /projects/{id}/stream
  if (method === "GET" && segments.length === 3 && segments[2] === "stream") {
    return handleGetProjectStream(req, url, segments[1]);
  }
  if (method === "POST" && segments[1] === "drafts" && segments[2] === "cleanup") {
    return handleCleanupDraftProjects(req, body);
  }
  // GET /projects/versions
  if (method === "GET" && segments[1] === "versions") {
    return handleGetVersions(req, segments, url);
  }
  // GET/POST/DELETE /projects/{id}/env
  if (segments[2] === "env") {
    const projectId = segments[1];
    if (!projectId) return json({ error: "projectId required" }, 400);
    if (method === "GET") return handleGetEnvVars(req, projectId);
    if (method === "POST") return handlePostEnvVar(req, projectId, body);
    if (method === "DELETE") return handleDeleteEnvVar(req, projectId, body);
  }
  // GET/POST /projects/{id}/services
  if (segments[2] === "services" && segments.length === 3) {
    const projectId = segments[1];
    if (!projectId) return json({ error: "projectId required" }, 400);
    if (method === "GET") return handleGetProjectServices(req, projectId);
    if (method === "POST") return handlePostProjectService(req, projectId, body);
  }
  // DELETE /projects/{id}/services/{stub}
  if (segments[2] === "services" && segments.length === 4) {
    const projectId = segments[1];
    const stub = segments[3];
    if (!projectId) return json({ error: "projectId required" }, 400);
    if (method === "DELETE") return handleDeleteProjectService(req, projectId, stub);
  }
  // GET/POST /projects/{id}/versions/{version}/source
  if (segments[2] === "versions" && segments[4] === "source") {
    const projectId = segments[1];
    const versionId = Number(segments[3]);
    if (method === "GET") return handleGetVersionSource(projectId, versionId);
    if (method === "POST") return handlePostVersionSource(projectId, versionId, body);
  }
  // GET /projects/{id}/chat
  if (method === "GET" && segments[2] === "chat") {
    return handleGetChat(segments[1]);
  }
  // GET /projects/{id}/staged-builds
  if (method === "GET" && segments[2] === "staged-builds") {
    return handleGetStagedBuilds(req, segments[1]);
  }
  // POST /projects/{id}/messages
  if (method === "POST" && segments[2] === "messages") {
    return handlePostMessage(req, segments[1], body);
  }
  // GET /projects
  if (method === "GET" && segments.length === 1) {
    return handleGetProjects(req, url);
  }
  // GET /projects/{id}
  if (method === "GET" && segments.length === 2) {
    return handleGetProject(req, segments[1]);
  }
  // POST /projects
  if (method === "POST" && segments.length === 1) {
    return handlePostProject(req, body);
  }
  // PATCH /projects/{id}
  if (method === "PATCH" && segments.length === 2) {
    return handlePatchProject(req, segments[1], body);
  }
  // DELETE /projects/{id}
  if (method === "DELETE" && segments.length === 2) {
    return handleDeleteProject(req, segments[1]);
  }
  return null;
}
