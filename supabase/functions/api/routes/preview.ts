import { admin } from "../lib/env.ts";
import { json, rewriteHtmlForSubpath } from "../lib/response.ts";
import { getUserOrService } from "../lib/auth.ts";
import { getProjectAccess } from "../lib/access.ts";
import { sha256Hex } from "../lib/crypto.ts";

const PREVIEW_CSP = [
  "default-src * data: blob: 'unsafe-inline' 'unsafe-eval'",
  "style-src * data: blob: 'unsafe-inline'",
  "script-src * data: blob: 'unsafe-inline' 'unsafe-eval'",
  "img-src * data: blob:",
  "font-src * data: blob:",
  "connect-src * data: blob:",
  "frame-src * data: blob:",
].join("; ");

const PREVIEW_TOKEN_COOKIE = "preview_access_token";
const SHARE_TOKEN_BYTES = 32;

function getCookieValue(header: string | null, name: string): string | null {
  if (!header) return null;
  const parts = header.split(";");
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const [key, ...rest] = trimmed.split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

function getPreviewToken(req: Request, url: URL): string | null {
  const authHeader = req.headers.get("Authorization") || "";
  if (authHeader.startsWith("Bearer ")) {
    return authHeader.replace("Bearer ", "").trim();
  }
  const queryToken = url.searchParams.get("access_token");
  if (queryToken) return queryToken;
  const cookieHeader = req.headers.get("cookie") || req.headers.get("Cookie");
  return getCookieValue(cookieHeader, PREVIEW_TOKEN_COOKIE);
}

function attachPreviewCookie(headers: Record<string, string>, token: string | null) {
  if (!token) return;
  headers["Set-Cookie"] = `${PREVIEW_TOKEN_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax`;
}

async function requirePreviewUser(req: Request, url: URL) {
  const token = getPreviewToken(req, url);
  if (!token) {
    return {
      user: null,
      token: null,
      response: new Response("unauthorized", {
        status: 401,
        headers: buildPreviewHeaders("text/plain"),
      }),
    };
  }
  const { data: { user } } = await admin.auth.getUser(token);
  if (!user) {
    return {
      user: null,
      token: null,
      response: new Response("unauthorized", {
        status: 401,
        headers: buildPreviewHeaders("text/plain"),
      }),
    };
  }
  return { user, token, response: null };
}

function buildPreviewHeaders(
  contentType?: string,
  withCsp = false,
  debug?: { branch?: string; restPath?: string; upstreamType?: string },
) {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Origin": "*",
    "X-Preview-Handler": "preview-v3",
  };
  if (debug?.branch) headers["X-Preview-Branch"] = debug.branch;
  if (debug?.restPath) headers["X-Preview-Rest-Path"] = debug.restPath;
  if (debug?.upstreamType) headers["X-Preview-Upstream-Type"] = debug.upstreamType;
  if (contentType) headers["X-Preview-Content-Type"] = contentType;
  if (contentType) headers["Content-Type"] = contentType;
  if (withCsp) headers["Content-Security-Policy"] = PREVIEW_CSP;
  return headers;
}

function baseHrefForPath(pathname: string) {
  let baseHref = pathname.replace(/\/+$/, "");
  if (baseHref.endsWith("/index.html") || baseHref.endsWith(".html")) {
    baseHref = baseHref.substring(0, baseHref.lastIndexOf("/") + 1);
  } else {
    baseHref = `${baseHref}/`;
  }
  return baseHref;
}

function getRequestBaseHref(req: Request, url: URL) {
  const headerCandidates = [
    "x-forwarded-uri",
    "x-original-uri",
    "x-envoy-original-path",
    "x-forwarded-path",
  ];
  for (const header of headerCandidates) {
    const val = req.headers.get(header);
    if (!val) continue;
    try {
      const parsed = new URL(val, `${url.protocol}//${url.host}`);
      return baseHrefForPath(parsed.pathname);
    } catch {
      if (val.startsWith("/")) return baseHrefForPath(val);
    }
  }
  let pathname = url.pathname;
  if (!pathname.startsWith("/functions/v1/") && pathname.startsWith("/api/")) {
    pathname = `/functions/v1${pathname}`;
  }
  return baseHrefForPath(pathname);
}

function parseBuildPreviewSegments(segments: string[]) {
  if (segments.length < 2) return null;
  if (segments[1]?.startsWith("build-")) {
    return { buildId: segments[1], restSegments: segments.slice(2) };
  }
  if (segments[1] === "build" && segments[2]) {
    return { buildId: segments[2], restSegments: segments.slice(3) };
  }
  return null;
}

function parseSharePreviewSegments(segments: string[]) {
  if (segments.length < 3) return null;
  if (segments[1] !== "share") return null;
  return { token: segments[2], restSegments: segments.slice(3) };
}

function generateShareToken() {
  const bytes = new Uint8Array(SHARE_TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function proxyPreviewFromBase(
  req: Request,
  url: URL,
  baseUrl: string,
  restPath: string,
  token: string | null,
  debugBranch: string,
) {
  if (!baseUrl.startsWith("http://") && !baseUrl.startsWith("https://")) {
    const headers = buildPreviewHeaders("text/plain", false, {
      branch: `${debugBranch}-invalid-url`,
      restPath,
    });
    attachPreviewCookie(headers, token);
    return new Response("invalid preview url", { status: 400, headers });
  }
  const base = new URL(baseUrl);
  const basePath = base.pathname.replace(/\/+$/, "") + "/";
  const upstream = new URL(basePath + restPath, `${base.protocol}//${base.host}`);
  const upstreamResp = await fetch(upstream.toString(), { redirect: "follow" });
  const contentType = upstreamResp.headers.get("Content-Type") || "";
  if (!upstreamResp.ok) {
    const headers = buildPreviewHeaders("text/plain", false, {
      branch: `${debugBranch}-upstream-error`,
      restPath,
      upstreamType: contentType || undefined,
    });
    attachPreviewCookie(headers, token);
    return new Response(`preview fetch failed (${upstreamResp.status})`, { status: upstreamResp.status, headers });
  }
  const isHtmlPath = restPath.toLowerCase().endsWith(".html");
  if (contentType.includes("text/html") || isHtmlPath) {
    const html = await upstreamResp.text();
    const baseHref = getRequestBaseHref(req, url);
    const rewritten = rewriteHtmlForSubpath(html, baseHref);
    const headers = buildPreviewHeaders("text/html; charset=utf-8", true, {
      branch: `${debugBranch}-html`,
      restPath,
      upstreamType: contentType || undefined,
    });
    attachPreviewCookie(headers, token);
    return new Response(rewritten, { status: 200, headers });
  }
  const body = await upstreamResp.arrayBuffer();
  const headers = buildPreviewHeaders(contentType || undefined, false, {
    branch: `${debugBranch}-binary`,
    restPath,
    upstreamType: contentType || undefined,
  });
  attachPreviewCookie(headers, token);
  return new Response(body, { status: 200, headers });
}

async function handleBuildPreview(req: Request, segments: string[], url: URL) {
  if (req.method.toUpperCase() !== "GET") return null;
  const parsed = parseBuildPreviewSegments(segments);
  if (!parsed) return null;
  const auth = await requirePreviewUser(req, url);
  if (auth.response) return auth.response;
  const { buildId, restSegments } = parsed;
  const restPath = restSegments.length === 0 ? "index.html" : restSegments.join("/");
  const { data: build, error } = await admin
    .from("builds")
    .select("id, artifacts, project_id")
    .eq("id", buildId)
    .maybeSingle();
  if (error || !build) {
    const headers = buildPreviewHeaders("text/plain", false, { branch: "vm-not-found", restPath });
    attachPreviewCookie(headers, auth.token);
    return new Response("build not found", { status: 404, headers });
  }
  const access = await getProjectAccess(build.project_id, auth.user.id);
  if (!access.project) {
    const headers = buildPreviewHeaders("text/plain", false, { branch: "vm-not-found", restPath });
    attachPreviewCookie(headers, auth.token);
    return new Response("build not found", { status: 404, headers });
  }
  const allowed = access.isOwner || access.isWorkspaceMember || access.isAdmin || !!access.project.is_public;
  if (!allowed) {
    const headers = buildPreviewHeaders("text/plain", false, { branch: "vm-forbidden", restPath });
    attachPreviewCookie(headers, auth.token);
    return new Response("forbidden", { status: 403, headers });
  }
  const webUrl = (build.artifacts as any)?.web as string | undefined;
  if (!webUrl) {
    const headers = buildPreviewHeaders("text/plain", false, { branch: "vm-missing-preview", restPath });
    attachPreviewCookie(headers, auth.token);
    return new Response("preview not available", { status: 404, headers });
  }
  return proxyPreviewFromBase(req, url, webUrl, restPath, auth.token, "vm");
}

async function handleCreatePreviewShare(req: Request, body: any) {
  const auth = await getUserOrService(req, { allowServiceKey: true });
  if (!auth.user && !auth.service) return json({ error: "unauthorized" }, 401);
  const projectId = (body?.project_id ?? body?.projectId ?? "").toString().trim();
  if (!projectId) return json({ error: "project_id required" }, 400);

  if (auth.user) {
    const access = await getProjectAccess(projectId, auth.user.id);
    if (!access.project) return json({ error: "not found" }, 404);
    if (!access.isOwner && !access.isWorkspaceMember && !access.isAdmin) {
      return json({ error: "forbidden" }, 403);
    }
  }

  const { data: project } = await admin
    .from("projects")
    .select("id, latest_build_id")
    .eq("id", projectId)
    .maybeSingle();
  if (!project) return json({ error: "not found" }, 404);

  const buildId = (body?.build_id ?? body?.buildId ?? project.latest_build_id ?? "").toString();
  if (!buildId) return json({ error: "build_id required" }, 400);

  const { data: build } = await admin
    .from("builds")
    .select("id, project_id, artifacts")
    .eq("id", buildId)
    .maybeSingle();
  if (!build || build.project_id !== projectId) return json({ error: "build not found" }, 404);

  const webUrl = (build.artifacts as any)?.web as string | undefined;
  if (!webUrl) return json({ error: "preview not available" }, 404);

  const token = generateShareToken();
  const tokenHash = await sha256Hex(token);
  const { error } = await admin.from("preview_shares").insert({
    token_hash: tokenHash,
    project_id: projectId,
    build_id: buildId,
    created_by: auth.user?.id ?? null,
  });
  if (error) return json({ error: error.message }, 500);

  return json({ token, project_id: projectId, build_id: buildId });
}

async function handleSharePreview(req: Request, segments: string[], url: URL) {
  if (req.method.toUpperCase() !== "GET") return null;
  const parsed = parseSharePreviewSegments(segments);
  if (!parsed) return null;
  const { token, restSegments } = parsed;
  const restPath = restSegments.length === 0 ? "index.html" : restSegments.join("/");
  if (!token) {
    const headers = buildPreviewHeaders("text/plain", false, { branch: "share-missing-token", restPath });
    return new Response("missing share token", { status: 400, headers });
  }
  const tokenHash = await sha256Hex(token);
  const { data: share, error } = await admin
    .from("preview_shares")
    .select("project_id, build_id, revoked_at")
    .eq("token_hash", tokenHash)
    .maybeSingle();
  if (error || !share || share.revoked_at) {
    const headers = buildPreviewHeaders("text/plain", false, { branch: "share-not-found", restPath });
    return new Response("preview not found", { status: 404, headers });
  }
  const { data: build } = await admin
    .from("builds")
    .select("id, artifacts")
    .eq("id", share.build_id)
    .maybeSingle();
  if (!build) {
    const headers = buildPreviewHeaders("text/plain", false, { branch: "share-build-missing", restPath });
    return new Response("preview not found", { status: 404, headers });
  }
  const webUrl = (build.artifacts as any)?.web as string | undefined;
  if (!webUrl) {
    const headers = buildPreviewHeaders("text/plain", false, { branch: "share-missing-preview", restPath });
    return new Response("preview not available", { status: 404, headers });
  }
  const { error: updateError } = await admin
    .from("preview_shares")
    .update({ last_accessed_at: new Date().toISOString() })
    .eq("token_hash", tokenHash);
  if (updateError) {
    console.warn("[preview] failed to update share last_accessed_at", updateError.message);
  }
  return proxyPreviewFromBase(req, url, webUrl, restPath, null, "share");
}

export async function handlePreview(req: Request, segments: string[], url: URL, body: any) {
  if (segments[0] !== "preview") return null;
  const method = req.method.toUpperCase();

  if (segments[1] === "share") {
    if (method === "POST" && segments.length === 2) {
      return handleCreatePreviewShare(req, body);
    }
    const sharePreview = await handleSharePreview(req, segments, url);
    if (sharePreview) return sharePreview;
    return json({ error: "not found" }, 404);
  }

  if (method !== "GET") return json({ error: "method not allowed" }, 405);

  const buildPreview = await handleBuildPreview(req, segments, url);
  if (buildPreview) return buildPreview;

  if (segments.length >= 3) {
    const headers = buildPreviewHeaders("text/plain", false, { branch: "legacy-removed", restPath: "index.html" });
    return new Response("preview endpoint removed", { status: 410, headers });
  }

  return null;
}
