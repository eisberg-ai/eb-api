import { json } from "../lib/response.ts";
import { admin } from "../lib/env.ts";
import { getUserOrService } from "../lib/auth.ts";
import { createNotification } from "../lib/notifications.ts";

async function handleListNotifications(req: Request, url: URL) {
  const { user } = await getUserOrService(req);
  if (!user) return json({ error: "unauthorized" }, 401);
  const limitRaw = Number(url.searchParams.get("limit") ?? 50);
  const offsetRaw = Number(url.searchParams.get("offset") ?? 0);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 100) : 50;
  const offset = Number.isFinite(offsetRaw) ? Math.max(offsetRaw, 0) : 0;
  const unreadOnly = ["1", "true"].includes((url.searchParams.get("unread") || "").toLowerCase());

  let query = admin
    .from("notifications")
    .select("id, user_id, project_id, type, title, body, action, created_at, read_at, expires_at", { count: "exact" })
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);
  if (unreadOnly) {
    query = query.is("read_at", null);
  }
  const { data, error, count } = await query;
  if (error) return json({ error: error.message }, 500);
  return json({ notifications: data ?? [], total: count ?? 0 });
}

async function handleMarkRead(req: Request, notificationId: string) {
  const { user } = await getUserOrService(req);
  if (!user) return json({ error: "unauthorized" }, 401);
  if (!notificationId) return json({ error: "notification_id_required" }, 400);
  const now = new Date().toISOString();
  const { data, error } = await admin
    .from("notifications")
    .update({ read_at: now })
    .eq("id", notificationId)
    .eq("user_id", user.id)
    .select("id, user_id, project_id, type, title, body, action, created_at, read_at, expires_at")
    .single();
  if (error) return json({ error: error.message }, 500);
  return json({ notification: data });
}

async function handleSendNotification(req: Request, body: any) {
  const auth = await getUserOrService(req, { allowServiceKey: true });
  if (!auth.service) return json({ error: "forbidden" }, 403);
  const userId = body?.user_id ?? body?.userId ?? body?.target_user_id ?? body?.targetUserId ?? null;
  if (!userId) return json({ error: "user_id_required" }, 400);
  const title = String(body?.title ?? "").trim();
  const message = String(body?.body ?? body?.message ?? "").trim();
  if (!title) return json({ error: "title_required" }, 400);
  if (!message) return json({ error: "body_required" }, 400);
  const type = String(body?.type ?? "system").trim() || "system";
  const projectId = body?.project_id ?? body?.projectId ?? null;
  const action = body?.action ?? null;
  const expiresAt = body?.expires_at ?? body?.expiresAt ?? null;
  const notification = await createNotification({
    userId,
    type,
    title,
    body: message,
    projectId,
    action,
    expiresAt,
  });
  return json({ notification });
}

async function handleRegisterDevice(req: Request, body: any) {
  const { user } = await getUserOrService(req);
  if (!user) return json({ error: "unauthorized" }, 401);
  const rawToken = body?.token ?? body?.device_token ?? body?.deviceToken ?? null;
  const subscription = body?.subscription ?? null;
  let token: string | null = null;
  let platform = body?.platform ?? body?.devicePlatform ?? null;
  if (subscription && typeof subscription === "object") {
    token = JSON.stringify(subscription);
    if (!platform) platform = "web";
  } else if (typeof rawToken === "string" && rawToken.trim()) {
    token = rawToken.trim();
  }
  if (!token) return json({ error: "device_token_required" }, 400);
  const now = new Date().toISOString();
  const { data, error } = await admin
    .from("notification_devices")
    .upsert({
      user_id: user.id,
      device_token: token,
      platform,
      updated_at: now,
      disabled_at: null,
      created_at: now,
    }, { onConflict: "user_id,device_token" })
    .select("id, user_id, device_token, platform, created_at, updated_at, disabled_at")
    .single();
  if (error) return json({ error: error.message }, 500);
  return json({ device: data });
}

export async function handleNotifications(req: Request, segments: string[], url: URL, body: any) {
  const method = req.method.toUpperCase();
  if (segments[0] === "devices" && method === "POST") {
    return handleRegisterDevice(req, body);
  }
  if (segments[0] !== "notifications") return null;
  if (method === "POST" && segments[1] === "send") {
    return handleSendNotification(req, body);
  }
  if (method === "GET" && segments.length === 1) {
    return handleListNotifications(req, url);
  }
  if (method === "POST" && segments.length >= 3 && segments[2] === "read") {
    return handleMarkRead(req, segments[1]);
  }
  return null;
}
