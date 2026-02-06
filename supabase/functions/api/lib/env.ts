import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.2";
import { AwsClient } from "https://esm.sh/aws4fetch@1.0.0?target=deno";
import Stripe from "npm:stripe@16.5.0";

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const defaultGcs = "https://storage.googleapis.com";
const gcsEndpoint = (Deno.env.get("GCS_ENDPOINT") ?? defaultGcs).replace(/\/+$/, "");
const gcsPreviewBucket = Deno.env.get("GCS_PREVIEW_BUCKET") ?? "preview";
const gcsMediaBucket = Deno.env.get("GCS_MEDIA_BUCKET") ?? "media";
// public base for media
const gcsMediaPublicBase = (
  Deno.env.get("GCS_MEDIA_PUBLIC_BASE")
  ?? Deno.env.get("GCS_PUBLIC_BASE")
  ?? ""
).replace(/\/+$/, "");
// public base for preview
const gcsPreviewPublicBase = (
  Deno.env.get("GCS_PREVIEW_PUBLIC_BASE")
  ?? Deno.env.get("GCS_PUBLIC_BASE")
  ?? ""
).replace(/\/+$/, "");
const gcsAccessKey = Deno.env.get("GCS_ACCESS_KEY_ID") ?? "";
const gcsSecretKey = Deno.env.get("GCS_SECRET_ACCESS_KEY") ?? "";

const storageClient = gcsAccessKey && gcsSecretKey
  ? new AwsClient({
      accessKeyId: gcsAccessKey,
      secretAccessKey: gcsSecretKey,
      service: "s3",
      region: "auto",
    })
  : null;
if (!supabaseUrl || !supabaseKey) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
}
if (!storageClient) {
  console.error("Missing GCS credentials: GCS_ACCESS_KEY_ID and/or GCS_SECRET_ACCESS_KEY not set");
}
const admin = createClient(supabaseUrl, supabaseKey);

const stripeSecretKey = Deno.env.get("STRIPE_SECRET_KEY") ?? "";
const stripeWebhookSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET") ?? "";
const stripe = stripeSecretKey
  ? new Stripe(stripeSecretKey, {
      apiVersion: "2024-06-20",
      httpClient: Stripe.createFetchHttpClient(),
    })
  : null;
const defaultSuccessUrl = Deno.env.get("BILLING_SUCCESS_URL") ?? undefined;
const defaultCancelUrl = Deno.env.get("BILLING_CANCEL_URL") ?? defaultSuccessUrl;
const publishSecretKey = Deno.env.get("PUBLISH_SECRET_KEY") ?? "";
const publishSecretKeyId = Deno.env.get("PUBLISH_SECRET_KEY_ID") ?? "default";
const defaultAgentVersion = Deno.env.get("DEFAULT_AGENT_VERSION") ?? "sonic_2d";
const expoAccessToken = Deno.env.get("EXPO_ACCESS_TOKEN") ?? "";
const vapidPublicKey = Deno.env.get("VAPID_PUBLIC_KEY") ?? "";
const vapidPrivateKey = Deno.env.get("VAPID_PRIVATE_KEY") ?? "";
const vapidSubject = Deno.env.get("VAPID_SUBJECT") ?? "";

/** Public API base URL for service proxy links. Prefer PUBLIC_API_URL env; else derive from request. */
function getApiBaseUrl(req?: Request): string {
  const fromEnv = Deno.env.get("PUBLIC_API_URL");
  if (fromEnv && fromEnv.trim()) return fromEnv.replace(/\/+$/, "");
  if (!req) return "";
  const u = new URL(req.url);
  const parts = u.pathname.split("/");
  const idx = parts.findIndex((p) => ["worker", "services", "projects"].includes(p));
  const prefix = idx >= 0 ? parts.slice(0, idx).join("/") : u.pathname;
  return (u.origin + prefix).replace(/\/+$/, "");
}

export {
  admin,
  storageClient,
  gcsEndpoint,
  gcsPreviewBucket,
  gcsMediaBucket,
  gcsMediaPublicBase,
  gcsPreviewPublicBase,
  stripe,
  stripeWebhookSecret,
  defaultSuccessUrl,
  defaultCancelUrl,
  supabaseKey,
  publishSecretKey,
  publishSecretKeyId,
  defaultAgentVersion,
  expoAccessToken,
  vapidPublicKey,
  vapidPrivateKey,
  vapidSubject,
  getApiBaseUrl,
};
