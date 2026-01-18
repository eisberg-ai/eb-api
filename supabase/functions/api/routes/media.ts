import { json } from "../lib/response.ts";
import { admin, awsClient, r2Endpoint, r2MediaBucket, r2MediaPublicBase } from "../lib/env.ts";
import { getUserOrService } from "../lib/auth.ts";
import { ensureProject } from "../lib/project.ts";

async function isWorkspaceMember(workspaceId: string | null, userId: string): Promise<boolean> {
  if (!workspaceId) return false;
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
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB
const ALLOWED_AUDIO_TYPES = ["audio/mpeg", "audio/wav", "audio/mp3", "audio/ogg", "audio/webm"];
const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp", "image/svg+xml"];
const ALLOWED_FILE_TYPES = ["application/pdf", "text/plain", "application/json", "image/jpeg", "image/png", "image/gif", "image/webp"];

function getMediaUrl(r2Key: string): string {
  if (r2MediaPublicBase) {
    return `${r2MediaPublicBase}/${r2Key}`;
  }
  const endpointHost = (() => {
    try {
      return new URL(r2Endpoint).host;
    } catch {
      return "";
    }
  })();
  if (endpointHost.startsWith("pub-")) {
    return `${r2Endpoint}/${r2Key}`;
  }
  try {
    const urlObj = new URL(r2Endpoint);
    const host = urlObj.host;
    if (host.includes("r2.cloudflarestorage.com")) {
      return `${urlObj.protocol}//${r2MediaBucket}.${host}/${r2Key}`;
    }
  } catch (_e) {
    // ignore bad endpoint
  }
  return `${r2Endpoint}/${r2MediaBucket}/${r2Key}`;
}

function buildMediaResponse(m: any, type: "audio" | "image") {
  const mediaId = m.id;
  const r2Key = m.r2_key || m.r2Key;
  const apiUrl = `/api/media/${type}/${mediaId}/file`;
  return {
    id: mediaId,
    filename: m.filename,
    mimeType: m.mime_type || m.mimeType,
    sizeBytes: m.size_bytes ?? m.sizeBytes,
    createdAt: m.created_at || m.createdAt || new Date().toISOString(),
    // Prefer a CDN/public R2 URL so the frontend can render <img> tags without auth headers.
    url: r2Key ? getMediaUrl(r2Key) : apiUrl,
    // Keep the API path as a fallback for any authenticated fetches.
    fileUrl: apiUrl,
  };
}

async function handleGetMediaList(req: Request, type: "audio" | "image", projectId?: string) {
  const { user } = await getUserOrService(req);
  if (!user) return json({ error: "unauthorized" }, 401);
  let query = admin
    .from("media")
    .select("id, filename, mime_type, size_bytes, r2_key, created_at, type")
    .eq("type", type)
    .neq("type", "file")
    .order("created_at", { ascending: false });
  if (projectId) {
    await ensureProject(projectId, user.id);
    const { data: project } = await admin.from("projects").select("workspace_id, owner_user_id").eq("id", projectId).single();
    if (!project) return json({ error: "project not found" }, 404);
    // allow project owner
    if (project.owner_user_id !== user.id) {
      if (project.workspace_id) {
        // check workspace membership for non-owners
        const member = await isWorkspaceMember(project.workspace_id, user.id);
        if (!member) return json({ error: "forbidden" }, 403);
      } else {
        // no workspace and not owner
        return json({ error: "forbidden" }, 403);
      }
    }
    query = query.eq("project_id", projectId);
  } else {
    query = query.eq("owner_user_id", user.id);
  }
  const { data: media, error } = await query;
  if (error) return json({ error: error.message }, 500);
  // double-check filter in case query builder has issues
  const filtered = (media ?? []).filter((m: any) => m.type === type && m.type !== "file");
  const items = filtered.map((m: any) => buildMediaResponse(m, type));
  return json({ items });
}

async function handleGetMediaItem(req: Request, type: "audio" | "image", mediaId: string) {
  const { user } = await getUserOrService(req);
  if (!user) return json({ error: "unauthorized" }, 401);
  const { data: media, error } = await admin
    .from("media")
    .select("id, project_id, filename, mime_type, size_bytes, r2_key, created_at")
    .eq("id", mediaId)
    .eq("type", type)
    .single();
  if (error || !media) return json({ error: "not found" }, 404);
  await ensureProject(media.project_id, user.id);
  const { data: project } = await admin.from("projects").select("workspace_id, owner_user_id").eq("id", media.project_id).single();
  if (!project) return json({ error: "project not found" }, 404);
  // allow project owner
  if (project.owner_user_id !== user.id) {
    if (project.workspace_id) {
      // check workspace membership for non-owners
      const member = await isWorkspaceMember(project.workspace_id, user.id);
      if (!member) return json({ error: "forbidden" }, 403);
    } else {
      // no workspace and not owner
      return json({ error: "forbidden" }, 403);
    }
  }
  return json(buildMediaResponse(media, type));
}

async function handleGetMediaFile(req: Request, type: "audio" | "image", mediaId: string) {
  const { user } = await getUserOrService(req);
  if (!user) return json({ error: "unauthorized" }, 401);
  const { data: media, error } = await admin
    .from("media")
    .select("id, project_id, r2_key, mime_type")
    .eq("id", mediaId)
    .eq("type", type)
    .single();
  if (error || !media) return json({ error: "not found" }, 404);
  await ensureProject(media.project_id, user.id);
  const { data: project } = await admin.from("projects").select("workspace_id, owner_user_id").eq("id", media.project_id).single();
  if (!project) return json({ error: "project not found" }, 404);
  // allow project owner
  if (project.owner_user_id !== user.id) {
    if (project.workspace_id) {
      // check workspace membership for non-owners
      const member = await isWorkspaceMember(project.workspace_id, user.id);
      if (!member) return json({ error: "forbidden" }, 403);
    } else {
      // no workspace and not owner
      return json({ error: "forbidden" }, 403);
    }
  }
  if (!awsClient) {
    return json({ error: "storage not configured" }, 500);
  }
  try {
    const objectUrl = new URL(r2Endpoint);
    const res = await awsClient.fetch(objectUrl.origin, {
      method: "GET",
      path: `/${r2MediaBucket}/${media.r2_key}`,
    });
    if (!res.ok) {
      const errorText = await res.text();
      console.error("r2 fetch failed", { status: res.status, error: errorText, r2Key: media.r2_key });
      return json({ error: `failed to fetch file: ${res.status} ${errorText}` }, 500);
    }
    const body = await res.arrayBuffer();
    const headers = new Headers();
    headers.set("Access-Control-Allow-Origin", "*");
    headers.set("Content-Type", media.mime_type);
    headers.set("Content-Length", body.byteLength.toString());
    return new Response(body, { status: 200, headers });
  } catch (err) {
    console.error("handleGetMediaFile error:", err);
    return json({ error: (err as Error).message }, 500);
  }
}

async function handlePostFile(req: Request, projectId: string) {
  try {
    const { user } = await getUserOrService(req);
    if (!user) return json({ error: "unauthorized" }, 401);
    await ensureProject(projectId, user.id);
    const { data: project } = await admin.from("projects").select("workspace_id, owner_user_id").eq("id", projectId).single();
    if (!project) return json({ error: "project not found" }, 404);
    // allow project owner
    if (project.owner_user_id === user.id) {
      // owner can upload
    } else if (project.workspace_id) {
      // check workspace membership for non-owners
      const member = await isWorkspaceMember(project.workspace_id, user.id);
      if (!member) return json({ error: "forbidden" }, 403);
    } else {
      // no workspace and not owner
      return json({ error: "forbidden" }, 403);
    }
    const formData = await req.formData();
    const file = formData.get("file") as File | null;
    if (!file) return json({ error: "file required" }, 400);
    if (file.size > MAX_FILE_SIZE) {
      return json({ error: `file too large. max size: ${MAX_FILE_SIZE / 1024 / 1024}MB` }, 400);
    }
    const fileId = `file-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const r2Key = `${projectId}/files/${fileId}-${file.name}`;
    const fileBuffer = await file.arrayBuffer();
    if (!awsClient) {
      return json({ error: "storage not configured" }, 500);
    }
    const objectUrl = new URL(r2Endpoint);
    const uploadUrl = `${objectUrl.origin}/${r2MediaBucket}/${r2Key}`;
    const uploadRes = await awsClient.fetch(uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Type": file.type,
      },
      body: fileBuffer,
    });
    if (!uploadRes.ok) {
      const errorText = await uploadRes.text();
      return json({ error: `upload failed: ${uploadRes.status} ${errorText}` }, 500);
    }
    const { error: insertError } = await admin.from("media").insert({
      id: fileId,
      project_id: projectId,
      owner_user_id: user.id,
      type: "file",
      r2_key: r2Key,
      filename: file.name,
      mime_type: file.type,
      size_bytes: file.size,
    });
    if (insertError) {
      return json({ error: insertError.message }, 500);
    }
    return json({
      id: fileId,
      filename: file.name,
      mimeType: file.type,
      sizeBytes: file.size,
      url: getMediaUrl(r2Key),
      fileUrl: `/api/media/file/${fileId}/file`,
      createdAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error("handlePostFile error:", err);
    return json({ error: (err as Error).message }, 500);
  }
}

async function handlePostMedia(req: Request, type: "audio" | "image", projectId: string) {
  try {
    const { user } = await getUserOrService(req);
    if (!user) return json({ error: "unauthorized" }, 401);
    await ensureProject(projectId, user.id);
    const { data: project } = await admin.from("projects").select("workspace_id, owner_user_id").eq("id", projectId).single();
    if (!project) return json({ error: "project not found" }, 404);
    // allow project owner
    if (project.owner_user_id === user.id) {
      // owner can upload
    } else if (project.workspace_id) {
      // check workspace membership for non-owners
      const member = await isWorkspaceMember(project.workspace_id, user.id);
      if (!member) return json({ error: "forbidden" }, 403);
    } else {
      // no workspace and not owner
      return json({ error: "forbidden" }, 403);
    }
    const formData = await req.formData();
    const file = formData.get("file") as File | null;
    if (!file) return json({ error: "file required" }, 400);
    const allowedTypes = type === "audio" ? ALLOWED_AUDIO_TYPES : ALLOWED_IMAGE_TYPES;
    if (!allowedTypes.includes(file.type)) {
      return json({ error: `invalid file type. allowed: ${allowedTypes.join(", ")}` }, 400);
    }
    if (file.size > MAX_FILE_SIZE) {
      return json({ error: `file too large. max size: ${MAX_FILE_SIZE / 1024 / 1024}MB` }, 400);
    }
    const mediaId = `media-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const r2Key = `${projectId}/${type}/${mediaId}-${file.name}`;
    const fileBuffer = await file.arrayBuffer();
    if (!awsClient) {
      return json({ error: "storage not configured" }, 500);
    }
    const objectUrl = new URL(r2Endpoint);
    const uploadUrl = `${objectUrl.origin}/${r2MediaBucket}/${r2Key}`;
    const uploadRes = await awsClient.fetch(uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Type": file.type,
      },
      body: fileBuffer,
    });
    if (!uploadRes.ok) {
      const errorText = await uploadRes.text();
      return json({ error: `upload failed: ${uploadRes.status} ${errorText}` }, 500);
    }
    const { error: insertError } = await admin.from("media").insert({
      id: mediaId,
      project_id: projectId,
      owner_user_id: user.id,
      type,
      r2_key: r2Key,
      filename: file.name,
      mime_type: file.type,
      size_bytes: file.size,
    });
    if (insertError) {
      return json({ error: insertError.message }, 500);
    }
    return json(
      buildMediaResponse(
        {
          id: mediaId,
          filename: file.name,
          mime_type: file.type,
          size_bytes: file.size,
          r2_key: r2Key,
          created_at: new Date().toISOString(),
        },
        type,
      ),
    );
  } catch (err) {
    console.error("handlePostMedia error:", err);
    return json({ error: (err as Error).message }, 500);
  }
}

async function handleGetFileList(req: Request, projectId?: string) {
  const { user } = await getUserOrService(req);
  if (!user) return json({ error: "unauthorized" }, 401);
  const query = admin
    .from("media")
    .select("id, filename, mime_type, size_bytes, r2_key, created_at")
    .eq("type", "file")
    .order("created_at", { ascending: false });
  if (projectId) {
    await ensureProject(projectId, user.id);
    const { data: project } = await admin.from("projects").select("workspace_id, owner_user_id").eq("id", projectId).single();
    if (!project) return json({ error: "project not found" }, 404);
    // allow project owner
    if (project.owner_user_id !== user.id) {
      if (project.workspace_id) {
        // check workspace membership for non-owners
        const member = await isWorkspaceMember(project.workspace_id, user.id);
        if (!member) return json({ error: "forbidden" }, 403);
      } else {
        // no workspace and not owner
        return json({ error: "forbidden" }, 403);
      }
    }
    query.eq("project_id", projectId);
  } else {
    query.eq("owner_user_id", user.id);
  }
  const { data: files, error } = await query;
  if (error) return json({ error: error.message }, 500);
  const items = (files ?? []).map((f: any) => ({
    id: f.id,
    filename: f.filename,
    mimeType: f.mime_type || f.mimeType,
    sizeBytes: f.size_bytes ?? f.sizeBytes,
    createdAt: f.created_at || f.createdAt || new Date().toISOString(),
    url: getMediaUrl(f.r2_key || f.r2Key),
    fileUrl: `/api/media/file/${f.id}/file`,
  }));
  return json({ items });
}

async function handleGetFileItem(req: Request, fileId: string) {
  const { user } = await getUserOrService(req);
  if (!user) return json({ error: "unauthorized" }, 401);
  const { data: file, error } = await admin
    .from("media")
    .select("id, project_id, filename, mime_type, size_bytes, r2_key, created_at")
    .eq("id", fileId)
    .eq("type", "file")
    .single();
  if (error || !file) return json({ error: "not found" }, 404);
  await ensureProject(file.project_id, user.id);
  const { data: project } = await admin.from("projects").select("workspace_id, owner_user_id").eq("id", file.project_id).single();
  if (!project) return json({ error: "project not found" }, 404);
  // allow project owner
  if (project.owner_user_id !== user.id) {
    if (project.workspace_id) {
      // check workspace membership for non-owners
      const member = await isWorkspaceMember(project.workspace_id, user.id);
      if (!member) return json({ error: "forbidden" }, 403);
    } else {
      // no workspace and not owner
      return json({ error: "forbidden" }, 403);
    }
  }
  return json({
    id: file.id,
    filename: file.filename,
    mimeType: file.mime_type || file.mimeType,
    sizeBytes: file.size_bytes ?? file.sizeBytes,
    createdAt: file.created_at || file.createdAt || new Date().toISOString(),
    url: getMediaUrl(file.r2_key || file.r2Key),
    fileUrl: `/api/media/file/${file.id}/file`,
  });
}

async function handleGetFile(req: Request, fileId: string) {
  const { user } = await getUserOrService(req);
  if (!user) return json({ error: "unauthorized" }, 401);
  const { data: file, error } = await admin
    .from("media")
    .select("id, project_id, r2_key, mime_type")
    .eq("id", fileId)
    .eq("type", "file")
    .single();
  if (error || !file) return json({ error: "not found" }, 404);
  await ensureProject(file.project_id, user.id);
  const { data: project } = await admin.from("projects").select("workspace_id, owner_user_id").eq("id", file.project_id).single();
  if (!project) return json({ error: "project not found" }, 404);
  // allow project owner
  if (project.owner_user_id !== user.id) {
    if (project.workspace_id) {
      // check workspace membership for non-owners
      const member = await isWorkspaceMember(project.workspace_id, user.id);
      if (!member) return json({ error: "forbidden" }, 403);
    } else {
      // no workspace and not owner
      return json({ error: "forbidden" }, 403);
    }
  }
  if (!awsClient) {
    return json({ error: "storage not configured" }, 500);
  }
  try {
    const objectUrl = new URL(r2Endpoint);
    const res = await awsClient.fetch(objectUrl.origin, {
      method: "GET",
      path: `/${r2MediaBucket}/${file.r2_key}`,
    });
    if (!res.ok) {
      const errorText = await res.text();
      console.error("r2 fetch failed", { status: res.status, error: errorText, r2Key: file.r2_key });
      return json({ error: `failed to fetch file: ${res.status} ${errorText}` }, 500);
    }
    const body = await res.arrayBuffer();
    const headers = new Headers();
    headers.set("Access-Control-Allow-Origin", "*");
    headers.set("Content-Type", file.mime_type);
    headers.set("Content-Length", body.byteLength.toString());
    return new Response(body, { status: 200, headers });
  } catch (err) {
    console.error("handleGetFile error:", err);
    return json({ error: (err as Error).message }, 500);
  }
}

export async function handleMedia(req: Request, segments: string[], _url: URL, _body: any) {
  const method = req.method.toUpperCase();
  if (segments[0] !== "media") return null;
  // handle files endpoints
  if (segments[1] === "file") {
    if (method === "GET" && segments.length === 2) {
      const projectId = new URL(req.url).searchParams.get("projectId") || undefined;
      return handleGetFileList(req, projectId);
    }
    if (method === "GET" && segments.length === 4 && segments[3] === "file") {
      return handleGetFile(req, segments[2]);
    }
    if (method === "GET" && segments.length === 3) {
      return handleGetFileItem(req, segments[2]);
    }
    if (method === "POST" && segments.length === 2) {
      const projectId = new URL(req.url).searchParams.get("projectId");
      if (!projectId) return json({ error: "projectId required" }, 400);
      return handlePostFile(req, projectId);
    }
    return null;
  }
  const type = segments[1] as "audio" | "image" | undefined;
  if (!type || (type !== "audio" && type !== "image")) {
    return json({ error: "invalid type. use /media/audio or /media/image" }, 400);
  }
  if (method === "GET" && segments.length === 2) {
    const projectId = new URL(req.url).searchParams.get("projectId") || undefined;
    return handleGetMediaList(req, type, projectId);
  }
  if (method === "GET" && segments.length === 4 && segments[3] === "file") {
    return handleGetMediaFile(req, type, segments[2]);
  }
  if (method === "GET" && segments.length === 3) {
    return handleGetMediaItem(req, type, segments[2]);
  }
  if (method === "POST" && segments.length === 2) {
    const projectId = new URL(req.url).searchParams.get("projectId");
    if (!projectId) return json({ error: "projectId required" }, 400);
    return handlePostMedia(req, type, projectId);
  }
  return null;
}

