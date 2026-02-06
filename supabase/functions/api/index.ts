import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { json, normalizePath } from "./lib/response.ts";
import { handleWaitlist } from "./routes/authWaitlist.ts";
import { handlePreview } from "./routes/preview.ts";
import { handleBilling } from "./routes/billing.ts";
import { handleChat } from "./routes/chat.ts";
import { handleWorkerJobs } from "./routes/workerJobs.ts";
import { handleWorkspaces } from "./routes/workspaces.ts";
import { handleProjects } from "./routes/projects.ts";
import { handleBuilds } from "./routes/builds.ts";
import { handleGenerate } from "./routes/generate.ts";
import { handleIcons } from "./routes/icons.ts";
import { handleServices } from "./routes/services.ts";
import { handleMedia } from "./routes/media.ts";
import { handleUsers } from "./routes/users.ts";
import { handleNotifications } from "./routes/notifications.ts";
import { handlePublish } from "./routes/publish.ts";
import { handleAdmin } from "./routes/admin.ts";
import { handleInvites } from "./routes/invites.ts";
import { handleGallery } from "./routes/gallery.ts";
import { handleVms } from "./routes/vms.ts";
import { handleRuntime } from "./routes/runtime.ts";
import { handleBackend } from "./routes/backend.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,Authorization,apikey,X-Client-Info",
};

const withCors = (resp: Response): Response => {
  const headers = new Headers(resp.headers);
  for (const [key, value] of Object.entries(corsHeaders)) {
    if (!headers.has(key)) headers.set(key, value);
  }
  return new Response(resp.body, { status: resp.status, headers });
};

const maybeWithCors = (resp: Response | null): Response | null => (resp ? withCors(resp) : null);

export const handler = async (req: Request) => {
  try {
    const url = new URL(req.url);
    const segments = normalizePath(url);
    const method = req.method.toUpperCase();

    console.log("[api] request", {
      method,
      path: url.pathname,
      segments: JSON.stringify(segments),
      host: req.headers.get("host"),
      origin: req.headers.get("origin"),
      referer: req.headers.get("referer"),
      userAgent: req.headers.get("user-agent"),
    });

    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const shouldReadBody = method !== "GET" && method !== "HEAD";
    const isMediaRoute = segments[0] === "media" && method === "POST";
    const rawBody = shouldReadBody && !isMediaRoute ? await req.text() : "";
    let body: any = {};
    if (rawBody) {
      try {
        body = JSON.parse(rawBody);
      } catch (_e) {
        body = {};
      }
    }

    const waitlistHandled = maybeWithCors(await handleWaitlist(req, segments, url, body));
    if (waitlistHandled) return waitlistHandled;

    const previewHandled = maybeWithCors(await handlePreview(req, segments, url, body));
    if (previewHandled) return previewHandled;

    const chatHandled = maybeWithCors(await handleChat(req, segments, url, body));
    if (chatHandled) return chatHandled;

    const billingHandled = maybeWithCors(await handleBilling(req, segments, url, rawBody, body));
    if (billingHandled) return billingHandled;

    const publishHandled = maybeWithCors(await handlePublish(req, segments, url, body));
    if (publishHandled) return publishHandled;

    const workerHandled = maybeWithCors(await handleWorkerJobs(req, segments, url, body));
    if (workerHandled) return workerHandled;

    const vmsHandled = maybeWithCors(await handleVms(req, segments, url, body));
    if (vmsHandled) return vmsHandled;

    const runtimeHandled = maybeWithCors(await handleRuntime(req, segments));
    if (runtimeHandled) return runtimeHandled;

    const usersHandled = maybeWithCors(await handleUsers(req, segments, url, body));
    if (usersHandled) return usersHandled;

    const notificationsHandled = maybeWithCors(await handleNotifications(req, segments, url, body));
    if (notificationsHandled) return notificationsHandled;

    const invitesHandled = maybeWithCors(await handleInvites(req, segments, url, body));
    if (invitesHandled) return invitesHandled;

    const wsHandled = maybeWithCors(await handleWorkspaces(req, segments, url, body));
    if (wsHandled) return wsHandled;

    const projectHandled = maybeWithCors(await handleProjects(req, segments, url, body));
    if (projectHandled) return projectHandled;

    const backendHandled = maybeWithCors(await handleBackend(req, segments, url, body));
    if (backendHandled) return backendHandled;

    const buildHandled = maybeWithCors(await handleBuilds(req, segments, url, body));
    if (buildHandled) return buildHandled;

    const genHandled = maybeWithCors(await handleGenerate(req, segments, url, body));
    if (genHandled) return genHandled;

    const iconsHandled = maybeWithCors(await handleIcons(req, segments, url, body));
    if (iconsHandled) return iconsHandled;

    const servicesHandled = maybeWithCors(await handleServices(req, segments, url, body));
    if (servicesHandled) return servicesHandled;

    const adminHandled = maybeWithCors(await handleAdmin(req, segments, url, body));
    if (adminHandled) return adminHandled;

    const galleryHandled = maybeWithCors(await handleGallery(req, segments, url, body));
    if (galleryHandled) return galleryHandled;

    try {
      const mediaHandled = maybeWithCors(await handleMedia(req, segments, url, body));
      if (mediaHandled) return mediaHandled;
    } catch (err) {
      console.error("handleMedia error:", err);
      return withCors(json({ error: (err as Error).message }, 500));
    }

    return withCors(json({ error: "not found" }, 404));
  } catch (err) {
    console.error("[api] unhandled error", err);
    return withCors(json({ error: "internal_error" }, 500));
  }
};

if (import.meta.main) {
  serve(handler);
}
