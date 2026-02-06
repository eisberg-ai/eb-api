import {
  ApplicationServer,
  importVapidKeys,
  type ExportedVapidKeys,
  type PushSubscription,
} from "https://raw.githubusercontent.com/negrel/webpush/0.3.0/mod.ts";
import { decodeBase64Url, encodeBase64Url } from "jsr:@std/encoding@0.224.0/base64url";
import { admin, expoAccessToken, vapidPublicKey, vapidPrivateKey, vapidSubject } from "./env.ts";

export type NotificationInput = {
  userId: string;
  type: string;
  title: string;
  body: string;
  projectId?: string | null;
  broadcastId?: string | null;
  action?: Record<string, unknown> | null;
  expiresAt?: string | null;
};

export async function createNotification(input: NotificationInput) {
  const payload = {
    user_id: input.userId,
    project_id: input.projectId ?? null,
    broadcast_id: input.broadcastId ?? null,
    type: input.type,
    title: input.title,
    body: input.body,
    action: input.action ?? null,
    expires_at: input.expiresAt ?? null,
  };
  const { data, error } = await admin
    .from("notifications")
    .insert(payload)
    .select("id, user_id, project_id, type, title, body, action, created_at, read_at, expires_at")
    .single();
  if (error) {
    throw new Error(error.message);
  }
  await sendPushNotifications(data);
  return data;
}

type PushPayload = {
  title: string;
  body: string;
  data: Record<string, unknown>;
};

let vapidServerPromise: Promise<ApplicationServer> | null = null;

function buildVapidKeys(publicKey: string, privateKey: string): ExportedVapidKeys {
  const publicRaw = decodeBase64Url(publicKey);
  if (publicRaw.length !== 65 || publicRaw[0] !== 4) {
    throw new Error("vapid_public_key_invalid");
  }
  const privateRaw = decodeBase64Url(privateKey);
  if (privateRaw.length !== 32) {
    throw new Error("vapid_private_key_invalid");
  }
  const x = publicRaw.slice(1, 33);
  const y = publicRaw.slice(33, 65);
  const jwkBase = {
    kty: "EC",
    crv: "P-256",
    x: encodeBase64Url(x),
    y: encodeBase64Url(y),
  };
  return {
    publicKey: jwkBase,
    privateKey: {
      ...jwkBase,
      d: encodeBase64Url(privateRaw),
    },
  };
}

async function getVapidServer(): Promise<ApplicationServer | null> {
  if (!vapidPublicKey || !vapidPrivateKey || !vapidSubject) return null;
  if (!vapidServerPromise) {
    const keys = buildVapidKeys(vapidPublicKey, vapidPrivateKey);
    vapidServerPromise = importVapidKeys(keys).then((vapidKeys) =>
      ApplicationServer.new({
        contactInformation: vapidSubject,
        vapidKeys,
      })
    );
  }
  return await vapidServerPromise;
}

async function sendExpoPush(token: string, payload: PushPayload) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (expoAccessToken) {
    headers["Authorization"] = `Bearer ${expoAccessToken}`;
  }
  const response = await fetch("https://exp.host/--/api/v2/push/send", {
    method: "POST",
    headers,
    body: JSON.stringify({
      to: token,
      title: payload.title,
      body: payload.body,
      data: payload.data,
    }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`expo_push_failed:${response.status}:${text}`);
  }
}

async function sendWebPush(subscriptionJson: string, payload: PushPayload) {
  const server = await getVapidServer();
  if (!server) return;
  const subscription = JSON.parse(subscriptionJson) as PushSubscription;
  if (!subscription?.endpoint || !subscription?.keys?.auth || !subscription?.keys?.p256dh) {
    throw new Error("web_push_subscription_invalid");
  }
  const subscriber = server.subscribe(subscription);
  await subscriber.pushTextMessage(JSON.stringify(payload), {});
}

async function sendPushNotifications(notification: any) {
  const { data: devices, error } = await admin
    .from("notification_devices")
    .select("device_token, platform")
    .eq("user_id", notification.user_id)
    .is("disabled_at", null);
  if (error) {
    throw new Error(error.message);
  }
  if (!devices || devices.length === 0) return;
  const url = notification.project_id ? `/projects/${notification.project_id}` : "/";
  const payload: PushPayload = {
    title: notification.title,
    body: notification.body,
    data: {
      notificationId: notification.id,
      projectId: notification.project_id ?? null,
      action: notification.action ?? null,
      url,
    },
  };
  for (const device of devices) {
    const platform = (device.platform ?? "").toString().toLowerCase();
    if (platform === "web") {
      await sendWebPush(device.device_token, payload);
    } else {
      await sendExpoPush(device.device_token, payload);
    }
  }
}
