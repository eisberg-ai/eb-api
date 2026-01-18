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
import { handleServices } from "./routes/services.ts";
import { handleMedia } from "./routes/media.ts";
import { handleUsers } from "./routes/users.ts";
import { handlePublish } from "./routes/publish.ts";
import { handleAdmin } from "./routes/admin.ts";
import { handleInvites } from "./routes/invites.ts";
import { handleGallery } from "./routes/gallery.ts";

export const handler = async (req: Request) => {
  const url = new URL(req.url);
  const segments = normalizePath(url);
  const method = req.method.toUpperCase();

  console.log("[api] request", {
    method,
    path: url.pathname,
    host: req.headers.get("host"),
    origin: req.headers.get("origin"),
    referer: req.headers.get("referer"),
    userAgent: req.headers.get("user-agent"),
  });

  if (method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type,Authorization",
      },
    });
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

  const waitlistHandled = await handleWaitlist(req, segments, url, body);
  if (waitlistHandled) return waitlistHandled;

  const previewHandled = await handlePreview(req, segments, url, body);
  if (previewHandled) return previewHandled;

  const chatHandled = await handleChat(req, segments, url, body);
  if (chatHandled) return chatHandled;

  const billingHandled = await handleBilling(req, segments, url, rawBody, body);
  if (billingHandled) return billingHandled;

  const publishHandled = await handlePublish(req, segments, url, body);
  if (publishHandled) return publishHandled;

  const workerHandled = await handleWorkerJobs(req, segments, url, body);
  if (workerHandled) return workerHandled;

  const usersHandled = await handleUsers(req, segments, url, body);
  if (usersHandled) return usersHandled;

  const invitesHandled = await handleInvites(req, segments, url, body);
  if (invitesHandled) return invitesHandled;

  const wsHandled = await handleWorkspaces(req, segments, url, body);
  if (wsHandled) return wsHandled;

  const projectHandled = await handleProjects(req, segments, url, body);
  if (projectHandled) return projectHandled;

  const buildHandled = await handleBuilds(req, segments, url, body);
  if (buildHandled) return buildHandled;

  const genHandled = await handleGenerate(req, segments, url, body);
  if (genHandled) return genHandled;

  const servicesHandled = await handleServices(req, segments, url, body);
  if (servicesHandled) return servicesHandled;

  const adminHandled = await handleAdmin(req, segments, url, body);
  if (adminHandled) return adminHandled;

  const galleryHandled = await handleGallery(req, segments, url, body);
  if (galleryHandled) return galleryHandled;

  try {
    const mediaHandled = await handleMedia(req, segments, url, body);
    if (mediaHandled) return mediaHandled;
  } catch (err) {
    console.error("handleMedia error:", err);
    return json({ error: (err as Error).message }, 500);
  }

  return json({ error: "not found" }, 404);
};

if (import.meta.main) {
  serve(handler);
}
