import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.2";
import { AwsClient } from "https://esm.sh/aws4fetch@1.0.0?target=deno";
import Stripe from "npm:stripe@16.5.0";

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const defaultR2 = "https://pub-952a37a2cafd47d487b07d44f3180e45.r2.dev";
const r2Endpoint = (Deno.env.get("CF_R2_ENDPOINT") ?? defaultR2).replace(/\/+$/, "");
const r2PreviewBucket = Deno.env.get("CF_R2_PREVIEW_BUCKET") ?? "preview";
const r2MediaBucket = Deno.env.get("CF_R2_MEDIA_BUCKET") ?? "media";
// public base for media
const r2MediaPublicBase = (
  Deno.env.get("CF_R2_MEDIA_PUBLIC_BASE")
  ?? Deno.env.get("CF_R2_PUBLIC_BASE")
  ?? ""
).replace(/\/+$/, "");
// public base for preview
const r2PreviewPublicBase = (
  Deno.env.get("CF_R2_PREVIEW_PUBLIC_BASE")
  ?? Deno.env.get("CF_R2_PUBLIC_BASE")
  ?? ""
).replace(/\/+$/, "");
const r2AccessKey = Deno.env.get("CF_R2_ACCESS_KEY_ID") ?? "";
const r2SecretKey = Deno.env.get("CF_R2_SECRET_ACCESS_KEY") ?? "";

const awsClient = r2AccessKey && r2SecretKey
  ? new AwsClient({
      accessKeyId: r2AccessKey,
      secretAccessKey: r2SecretKey,
      service: "s3",
      region: "auto",
    })
  : null;
if (!supabaseUrl || !supabaseKey) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
}
if (!awsClient) {
  console.error("Missing R2 credentials: CF_R2_ACCESS_KEY_ID and/or CF_R2_SECRET_ACCESS_KEY not set");
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
const defaultAgentVersion = Deno.env.get("DEFAULT_AGENT_VERSION") ?? "sonic_2e";

export {
  admin,
  awsClient,
  r2Endpoint,
  r2PreviewBucket,
  r2MediaBucket,
  r2MediaPublicBase,
  r2PreviewPublicBase,
  stripe,
  stripeWebhookSecret,
  defaultSuccessUrl,
  defaultCancelUrl,
  supabaseKey,
  publishSecretKey,
  publishSecretKeyId,
  defaultAgentVersion,
};
