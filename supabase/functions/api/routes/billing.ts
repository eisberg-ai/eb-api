import { json } from "../lib/response.ts";
import { admin, stripe, stripeWebhookSecret, defaultSuccessUrl, defaultCancelUrl } from "../lib/env.ts";
import { getUserOrService } from "../lib/auth.ts";
import { PLANS, getPlan, type PlanKey } from "../lib/plans.ts";
import { createNotification } from "../lib/notifications.ts";
import { clearPrivateExpiryForUser, computePrivateExpiryAt, markPrivateProjectsPendingExpiry } from "../lib/privateProjects.ts";
import { MIN_BUILD_BALANCE, spendBuildCredits } from "../lib/build.ts";
import { DEFAULT_LLM_PRICING, PLATFORM_FEE_RATE, parseLlmPricing, quoteLlmUsage } from "../lib/llm_pricing.ts";
import type Stripe from "npm:stripe@16.5.0";

const planTier: Record<string, number> = {
  'free': 0,
  'plus': 1,
  'pro': 2,
  'max': 3,
};

function safeTimestampToISO(timestamp: number | null | undefined): string | null {
  if (!timestamp || timestamp <= 0) return null;
  const date = new Date(timestamp * 1000);
  if (isNaN(date.getTime())) return null;
  return date.toISOString();
}

export type CreditPack = { key: string; priceId: string; credits: number; name?: string };
export type CreditLedgerRow = {
  id: string;
  type: string;
  credits_delta: number;
  description: string | null;
  metadata: Record<string, unknown> | null;
  amount_cents: number | null;
  currency: string | null;
  stripe_payment_intent_id: string | null;
  stripe_event_id: string | null;
  idempotency_key: string | null;
  balance_after: number;
  created_at: string;
};

type PromoCodeRow = {
  code: string;
  credits: number;
  created_by?: string | null;
  created_by_email?: string | null;
  created_at?: string | null;
  redeemed_by?: string | null;
  redeemed_email?: string | null;
  redeemed_at?: string | null;
};

export function parseCreditPacks(): CreditPack[] {
  const raw = Deno.env.get("CREDIT_PACKS");
  if (raw && raw.trim()) {
    const trimmed = raw.trim();
    const unwrapped = (trimmed.startsWith("'") && trimmed.endsWith("'")) || (trimmed.startsWith("\"") && trimmed.endsWith("\""))
      ? trimmed.slice(1, -1)
      : trimmed;
    try {
      const parsed = JSON.parse(unwrapped);
      if (Array.isArray(parsed)) {
        return parsed
          .map((p) => ({
            key: p.key ?? p.id ?? "",
            priceId: p.priceId ?? p.price_id ?? "",
            credits: Number(p.credits ?? 0),
            name: p.name ?? p.label ?? undefined,
          }))
          .filter((p) => p.key && p.priceId && p.credits > 0);
      }
    } catch (err) {
      console.error("failed to parse CREDIT_PACKS", err);
    }
  }
  const fallbackPrice = Deno.env.get("STRIPE_PRICE_CREDITS") ?? "";
  const fallbackCredits = Number(Deno.env.get("CREDIT_PACK_CREDITS") ?? "0");
  if (fallbackPrice && fallbackCredits > 0) {
    return [{ key: "default", priceId: fallbackPrice, credits: fallbackCredits, name: "Credits" }];
  }
  return [];
}

function normalizePromoCode(code: string): string {
  return code.trim().toUpperCase();
}

async function fetchPromoCode(code: string): Promise<PromoCodeRow | null> {
  const { data, error } = await admin
    .from("promo_codes")
    .select("code,credits,created_by,created_by_email,created_at,redeemed_by,redeemed_email,redeemed_at")
    .eq("code", code)
    .maybeSingle();
  if (error) {
    console.error("promo code lookup failed", error);
    throw new Error("promo_lookup_failed");
  }
  return data ?? null;
}

export function selectPack(packs: CreditPack[], key?: string | null): CreditPack | null {
  if (!packs.length) return null;
  if (key) {
    const normalized = key.toString();
    const found = packs.find((p) => p.key === normalized);
    if (found) return found;
  }
  return packs[0];
}

async function handlePostPromo(req: Request, body: any) {
  const { user } = await getUserOrService(req);
  if (!user) return json({ error: "unauthorized" }, 401);
  const rawCode = (body?.code ?? body?.promoCode ?? body?.promo_code ?? "").toString();
  const code = normalizePromoCode(rawCode);
  if (!code) return json({ error: "promo_code_required" }, 400);
  let promo: PromoCodeRow | null = null;
  try {
    promo = await fetchPromoCode(code);
  } catch (err: any) {
    return json({ error: err?.message ?? "promo_lookup_failed" }, 500);
  }
  if (!promo) return json({ error: "invalid_promo_code" }, 400);
  if (promo.redeemed_at || promo.redeemed_by) {
    return json({ error: "promo_code_used" }, 409);
  }

  const now = new Date().toISOString();
  const { data: claimed, error: claimError } = await admin
    .from("promo_codes")
    .update({
      redeemed_by: user.id,
      redeemed_email: user.email?.toLowerCase() ?? null,
      redeemed_at: now,
      updated_at: now,
    })
    .eq("code", promo.code)
    .is("redeemed_at", null)
    .select("code,credits")
    .maybeSingle();
  if (claimError) {
    console.error("promo claim error", claimError);
    return json({ error: "promo_lookup_failed" }, 500);
  }
  if (!claimed) {
    return json({ error: "promo_code_used" }, 409);
  }

  try {
    const entry = await applyCreditDelta({
      userId: user.id,
      delta: Number(claimed.credits ?? promo.credits ?? 0),
      type: "purchase",
      description: `Promo code ${promo.code}`,
      metadata: {
        promoCode: promo.code,
        promoCredits: Number(claimed.credits ?? promo.credits ?? 0),
      },
      idempotencyKey: `promo:${user.id}:${promo.code}`,
    });
    try {
      const { data: profile } = await admin
        .from("user_profiles")
        .select("join_method")
        .eq("user_id", user.id)
        .maybeSingle();
      if (!profile?.join_method) {
        await admin.from("user_profiles").upsert({
          user_id: user.id,
          join_method: "promo",
          join_code: promo.code,
          updated_at: now,
        }, { onConflict: "user_id" });
      }
    } catch (err) {
      console.error("failed to update join method", err);
    }
    return json({ balance: entry.balance_after, entry, promo: { code: promo.code, credits: Number(claimed.credits ?? promo.credits ?? 0) } });
  } catch (err: any) {
    const message = err?.message ?? "promo_redeem_failed";
    return json({ error: message }, 500);
  }
}

export async function applyCreditDelta(args: {
  userId: string;
  delta: number;
  type: "purchase" | "spend" | "adjustment";
  description?: string;
  metadata?: Record<string, unknown> | null;
  amountCents?: number | null;
  currency?: string | null;
  paymentIntentId?: string | null;
  stripeEventId?: string | null;
  idempotencyKey?: string | null;
}): Promise<CreditLedgerRow> {
  const { data, error } = await admin.rpc("apply_credit_delta", {
    p_user_id: args.userId,
    p_delta: args.delta,
    p_type: args.type,
    p_description: args.description ?? null,
    p_metadata: args.metadata ?? {},
    p_amount_cents: args.amountCents ?? null,
    p_currency: args.currency ?? null,
    p_stripe_payment_intent_id: args.paymentIntentId ?? null,
    p_stripe_event_id: args.stripeEventId ?? null,
    p_idempotency_key: args.idempotencyKey ?? null,
  });
  if (error) {
    throw new Error(error.message);
  }
  return data as CreditLedgerRow;
}

function coerceNumber(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

export async function getCreditBalance(userId: string): Promise<number> {
  const { data, error } = await admin.from("credit_balances").select("balance").eq("user_id", userId).single();
  if (error && (error as any).code !== "PGRST116") {
    throw error;
  }
  return coerceNumber(data?.balance ?? 0);
}

async function drainRemainingCredits(args: {
  userId: string;
  reason: string;
  metadata?: Record<string, unknown> | null;
  idempotencyKey?: string | null;
}): Promise<{ balance: number; drained: number }> {
  const balanceBefore = await getCreditBalance(args.userId);
  if (balanceBefore <= 0) return { balance: 0, drained: 0 };
  try {
    const entry = await applyCreditDelta({
      userId: args.userId,
      delta: -balanceBefore,
      type: "spend",
      description: args.reason,
      metadata: args.metadata ?? {},
      idempotencyKey: args.idempotencyKey ? `drain-${args.idempotencyKey}` : null,
    });
    return { balance: coerceNumber(entry.balance_after), drained: balanceBefore };
  } catch (err) {
    console.error("failed to drain remaining credits", err);
    return { balance: 0, drained: 0 };
  }
}

export async function ensureStripeCustomer(user: { id: string; email?: string | null }): Promise<string> {
  if (!stripe) throw new Error("stripe_not_configured");
  const { data: existingRows, error: existingError } = await admin
    .from("stripe_customers")
    .select("customer_id")
    .eq("user_id", user.id)
    .limit(1);
  if (existingError) {
    console.error("stripe_customers lookup error", existingError);
  }
  const existing = existingRows?.[0]?.customer_id;
  if (existing) return existing as string;
  const customer = await stripe.customers.create({
    email: user.email ?? undefined,
    metadata: { user_id: user.id },
  });
  const { error: upsertErr } = await admin
    .from("stripe_customers")
    .upsert({ user_id: user.id, customer_id: customer.id }, { onConflict: "user_id" });
  if (upsertErr) {
    console.error("stripe_customers upsert error", upsertErr);
  }
  return customer.id;
}

async function spendCredits(args: { req: Request; body: any; allowService: boolean }): Promise<Response> {
  const auth = await getUserOrService(args.req, { allowServiceKey: args.allowService });
  const isService = auth.service;
  const user = auth.user;
  const userId = isService ? (args.body.userId ?? args.body.user_id) : user?.id;
  if (!userId) return json({ error: "unauthorized" }, 401);
  const credits = Number(args.body.credits ?? args.body.amount ?? 0);
  if (!credits || credits <= 0) return json({ error: "credits must be > 0" }, 400);
  const description = (args.body.description as string | undefined) || "usage";
  const metadata = (args.body.metadata as Record<string, unknown> | undefined) ?? {};
  const idempotencyKey = (args.body.idempotencyKey as string | undefined) ?? (args.body.requestId as string | undefined) ?? null;
  try {
    const entry = await applyCreditDelta({
      userId,
      delta: -credits,
      type: "spend",
      description,
      metadata,
      idempotencyKey,
    });
    return json({ balance: entry.balance_after, entry });
  } catch (err: any) {
    const message = err?.message ?? "spend_failed";
    if (typeof message === "string" && message.toLowerCase().includes("insufficient")) {
      return json({ error: "insufficient_balance" }, 400);
    }
    return json({ error: message }, 500);
  }
}

async function handleGetPacks() {
  const creditPacks = parseCreditPacks();
  return json({ packs: creditPacks });
}

async function handlePostCheckoutSession(req: Request, url: URL, body: any) {
  if (!stripe) return json({ error: "stripe_not_configured" }, 500);
  const creditPacks = parseCreditPacks();
  if (!creditPacks.length) return json({ error: "no_credit_packs_configured" }, 500);
  const { user } = await getUserOrService(req);
  if (!user) return json({ error: "unauthorized" }, 401);
  const packKey = body?.packKey ?? body?.pack ?? body?.priceId ?? null;
  const pack = selectPack(creditPacks, packKey);
  if (!pack) return json({ error: "invalid_pack" }, 400);
  const originHeader = req.headers.get("origin") || req.headers.get("referer") || url.origin;
  const successUrl = body?.successUrl || defaultSuccessUrl || `${originHeader}/billing/success`;
  const cancelUrl = body?.cancelUrl || defaultCancelUrl || originHeader;
  const customerId = await ensureStripeCustomer(user);
  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    customer: customerId,
    line_items: [
      {
        price: pack.priceId,
        quantity: 1,
      },
    ],
    success_url: successUrl,
    cancel_url: cancelUrl,
    client_reference_id: pack.key,
    payment_intent_data: {
      metadata: {
        user_id: user.id,
        pack_key: pack.key,
        credits: pack.credits.toString(),
      },
    },
    metadata: {
      user_id: user.id,
      pack_key: pack.key,
      credits: pack.credits.toString(),
    },
  });
  return json({ url: session.url, id: session.id });
}

async function handlePostCreditsCheckoutSession(req: Request, url: URL, body: any) {
  if (!stripe) return json({ error: "stripe_not_configured" }, 500);
  const auth = await getUserOrService(req, { allowServiceKey: true });
  let user = auth.user ?? null;
  const isService = auth.service;
  const userId = isService
    ? (body?.userId ?? body?.user_id ?? null)
    : user?.id ?? null;
  if (!userId) return json({ error: "unauthorized" }, 401);
  if (!user && isService) {
    const { data, error } = await admin.auth.admin.getUserById(userId);
    if (error || !data?.user) {
      return json({ error: "user_not_found" }, 404);
    }
    user = data.user;
  }
  if (!user) return json({ error: "unauthorized" }, 401);

  const rawAmount = body?.amount ?? body?.amountUsd ?? body?.price ?? null;
  const rawAmountCents = body?.amountCents ?? body?.amount_cents ?? null;
  const amountCents = rawAmountCents != null
    ? Math.round(Number(rawAmountCents))
    : Math.round(Number(rawAmount ?? 0) * 100);
  if (!Number.isFinite(amountCents) || amountCents <= 0) {
    return json({ error: "amount_required" }, 400);
  }
  const minAmountCents = 100;
  const maxAmountCents = 1_000_000;
  if (amountCents < minAmountCents || amountCents > maxAmountCents) {
    return json({ error: "amount_out_of_range" }, 400);
  }
  const credits = Number(body?.credits ?? body?.creditAmount ?? body?.credit_amount ?? rawAmount ?? (amountCents / 100));
  if (!Number.isFinite(credits) || credits <= 0) {
    return json({ error: "credits_required" }, 400);
  }
  const currency = (body?.currency ?? "usd").toString().toLowerCase();
  if (!/^[a-z]{3}$/.test(currency)) {
    return json({ error: "invalid_currency" }, 400);
  }

  const originHeader = req.headers.get("origin") || req.headers.get("referer") || url.origin;
  const successUrl = body?.successUrl || defaultSuccessUrl || `${originHeader}/billing/success`;
  const cancelUrl = body?.cancelUrl || defaultCancelUrl || originHeader;
  const customerId = await ensureStripeCustomer(user);
  const packKey = body?.packKey ?? body?.pack_key ?? "custom";
  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    customer: customerId,
    line_items: [
      {
        price_data: {
          currency,
          unit_amount: amountCents,
          product_data: {
            name: "Credits",
          },
        },
        quantity: 1,
      },
    ],
    success_url: successUrl,
    cancel_url: cancelUrl,
    client_reference_id: packKey,
    payment_intent_data: {
      metadata: {
        user_id: userId,
        pack_key: packKey,
        credits: credits.toString(),
        credit_amount: credits.toString(),
        amount_cents: amountCents.toString(),
        currency,
      },
    },
    metadata: {
      user_id: userId,
      pack_key: packKey,
      credits: credits.toString(),
      credit_amount: credits.toString(),
      amount_cents: amountCents.toString(),
      currency,
    },
  });
  return json({ url: session.url, id: session.id });
}

async function handlePostSubscriptionCheckout(req: Request, url: URL, body: any) {
  if (!stripe) return json({ error: "stripe_not_configured" }, 500);
  const { user } = await getUserOrService(req);
  if (!user) return json({ error: "unauthorized" }, 401);
  const planKey = (body?.planKey ?? body?.plan ?? null) as PlanKey | null;
  const plan = getPlan(planKey);
  if (!plan || plan.key === 'free') return json({ error: "invalid_plan" }, 400);
  if (!plan.stripePriceId) {
    console.warn(`plan ${planKey} missing stripePriceId - using test mode`);
    return json({ error: "plan_not_configured", message: `Plan ${plan.name} needs a Stripe Price ID configured` }, 500);
  }
  const customerId = await ensureStripeCustomer(user);
  const { data: existingSub } = await admin.from("user_subscriptions").select("stripe_subscription_id, plan_key").eq("user_id", user.id).maybeSingle();
  if (existingSub?.stripe_subscription_id && existingSub.plan_key !== plan.key) {
    const subscription = await stripe.subscriptions.retrieve(existingSub.stripe_subscription_id);
    const currentPriceId = subscription.items.data[0]?.price?.id;
    if (currentPriceId && currentPriceId !== plan.stripePriceId) {
      await stripe.subscriptions.update(existingSub.stripe_subscription_id, {
        items: [{ id: subscription.items.data[0].id, price: plan.stripePriceId }],
        proration_behavior: 'create_prorations',
        metadata: { user_id: user.id, plan_key: plan.key },
      });
      const originHeader = req.headers.get("origin") || req.headers.get("referer") || url.origin;
      return json({ updated: true, message: "Subscription updated successfully", url: `${originHeader}/billing/success?updated=true` });
    }
  }
  const originHeader = req.headers.get("origin") || req.headers.get("referer") || url.origin;
  const successUrl = body?.successUrl || defaultSuccessUrl || `${originHeader}/billing/success?session_id={CHECKOUT_SESSION_ID}`;
  const cancelUrl = body?.cancelUrl || defaultCancelUrl || originHeader;
  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    line_items: [{ price: plan.stripePriceId, quantity: 1 }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    metadata: { user_id: user.id, plan_key: plan.key },
    subscription_data: {
      metadata: { user_id: user.id, plan_key: plan.key },
    },
  });
  return json({ url: session.url, id: session.id });
}

async function handlePostWebhook(req: Request, rawBody: string) {
  if (!stripe) {
    console.error("stripe webhook missing config");
    return json({ error: "stripe_not_configured" }, 500);
  }
  const signature = req.headers.get("stripe-signature") ?? "";
  let event: Stripe.Event;
  if (!stripeWebhookSecret) {
    console.error("stripe webhook secret missing");
    return json({ error: "stripe_webhook_secret_missing" }, 500);
  }
  if (!signature) {
    return json({ error: "missing_signature" }, 400);
  }
  try {
    event = await stripe.webhooks.constructEventAsync(rawBody, signature, stripeWebhookSecret);
  } catch (err: any) {
    console.error("stripe webhook signature failed", err?.message ?? err);
    return json({ error: "invalid_signature" }, 400);
  }
  try {
    if (event.type === "checkout.session.completed") {
      const session = event.data.object as Stripe.Checkout.Session;
      const metadata = (session.metadata ?? {}) as Record<string, string>;
      const userId = metadata.user_id;
      if (session.mode === "subscription" && session.subscription) {
        const subscription = typeof session.subscription === "string"
          ? await stripe.subscriptions.retrieve(session.subscription)
          : session.subscription;
        let planKey = (metadata.plan_key ?? subscription.metadata?.plan_key) as PlanKey;
        if (!planKey && subscription.items?.data?.[0]?.price?.id) {
          const priceId = subscription.items.data[0].price.id;
          const matchingPlan = Object.values(PLANS).find(p => p.stripePriceId === priceId);
          if (matchingPlan) {
            planKey = matchingPlan.key;
            console.log(`found plan_key from price_id: ${planKey} for price ${priceId}`);
          } else {
            console.warn(`no matching plan found for price_id: ${priceId}`);
          }
        }
        if (!planKey) {
          console.error("checkout.session.completed: missing plan_key", { metadata, subscriptionMetadata: subscription.metadata, priceId: subscription.items?.data?.[0]?.price?.id });
        }
        const plan = getPlan(planKey);
        if (plan && userId) {
          try {
            await admin.from("user_subscriptions").upsert({
            user_id: userId,
            plan_key: plan.key,
            stripe_subscription_id: subscription.id,
            stripe_customer_id: subscription.customer as string,
            status: subscription.status,
            current_period_start: safeTimestampToISO(subscription.current_period_start),
            current_period_end: safeTimestampToISO(subscription.current_period_end),
            credits_allocated_this_period: plan.creditsMonthly,
            updated_at: new Date().toISOString(),
          }, { onConflict: "user_id" });
          await applyCreditDelta({
            userId,
            delta: plan.creditsMonthly,
            type: "purchase",
            description: `Subscription: ${plan.name} - Monthly credits`,
            metadata: { planKey: plan.key, subscriptionId: subscription.id },
            stripeEventId: event.id,
            idempotencyKey: `subscription-${subscription.id}-${subscription.current_period_start}`,
          });
          } catch (err: any) {
            if (err?.code === "23503" || err?.message?.includes("foreign key")) {
              console.error("checkout.session.completed: user not found or foreign key violation", { userId, subscriptionId: subscription.id, error: err.message });
              return json({ received: true, warning: "user_not_found" });
            }
            throw err;
          }
        }
      } else {
        // credit pack purchase (not subscription)
        let credits = Number(metadata.credits ?? metadata.credit_amount ?? 0);
        if (userId && credits > 0) {
          // check if user is on max plan for bonus credits
          const { data: userSub } = await admin.from("user_subscriptions").select("plan_key").eq("user_id", userId).maybeSingle();
          const userPlan = getPlan(userSub?.plan_key);
          if (userPlan?.creditPurchaseBonus && userPlan.creditPurchaseBonus > 0) {
            const bonusCredits = credits * userPlan.creditPurchaseBonus;
            credits = credits + bonusCredits;
            console.log(`applied ${userPlan.creditPurchaseBonus * 100}% bonus: ${bonusCredits} extra credits for ${userPlan.name} user`);
          }
          const paymentIntentId = typeof session.payment_intent === "string"
            ? session.payment_intent
            : session.payment_intent?.id ?? null;
          await applyCreditDelta({
            userId,
            delta: credits,
            type: "purchase",
            description: `Stripe checkout ${metadata.pack_key || session.id}${userPlan?.creditPurchaseBonus ? ` (+${userPlan.creditPurchaseBonus * 100}% bonus)` : ''}`,
            metadata: {
              packKey: metadata.pack_key ?? null,
              checkoutSessionId: session.id,
              bonusApplied: userPlan?.creditPurchaseBonus ?? 0,
            },
            amountCents: typeof session.amount_total === "number" ? session.amount_total : null,
            currency: session.currency ?? "usd",
            paymentIntentId,
            stripeEventId: event.id,
            idempotencyKey: session.id,
          });
        } else {
          console.error("checkout.session.completed missing user_id/credits", { metadata });
        }
      }
    } else if (event.type === "customer.subscription.created" || event.type === "customer.subscription.updated") {
      const subscription = event.data.object as Stripe.Subscription;
      const userId = subscription.metadata?.user_id;
      let planKey = subscription.metadata?.plan_key as PlanKey;
      if (!planKey && subscription.items?.data?.[0]?.price?.id) {
        const priceId = subscription.items.data[0].price.id;
        const matchingPlan = Object.values(PLANS).find(p => p.stripePriceId === priceId);
        if (matchingPlan) {
          planKey = matchingPlan.key;
          console.log(`found plan_key from price_id: ${planKey} for price ${priceId}`);
        } else {
          console.warn(`no matching plan found for price_id: ${priceId}`);
        }
      }
      if (!planKey) {
        console.error(`${event.type}: missing plan_key`, { subscriptionMetadata: subscription.metadata, priceId: subscription.items?.data?.[0]?.price?.id });
      }
      if (userId && planKey) {
        const plan = getPlan(planKey);
        if (plan) {
          try {
            const { data: existingSub } = await admin.from("user_subscriptions").select("plan_key, credits_allocated_this_period").eq("user_id", userId).maybeSingle();
            const oldPlanKey = existingSub?.plan_key as PlanKey | undefined;
            const oldPlan = oldPlanKey ? getPlan(oldPlanKey) : null;
            const isUpgrade = oldPlan && planTier[plan.key] > planTier[oldPlan.key];
            const isDowngrade = oldPlan && planTier[plan.key] < planTier[oldPlan.key];
            await admin.from("user_subscriptions").upsert({
            user_id: userId,
            plan_key: plan.key,
            stripe_subscription_id: subscription.id,
            stripe_customer_id: subscription.customer as string,
            status: subscription.status,
            current_period_start: safeTimestampToISO(subscription.current_period_start),
            current_period_end: safeTimestampToISO(subscription.current_period_end),
            credits_allocated_this_period: isDowngrade ? (existingSub?.credits_allocated_this_period ?? plan.creditsMonthly) : plan.creditsMonthly,
            updated_at: new Date().toISOString(),
          }, { onConflict: "user_id" });
          const isUpgradeFromFree = !oldPlanKey || oldPlanKey === "free";
          if (plan.key !== "free") {
            await clearPrivateExpiryForUser(userId);
            if (isUpgradeFromFree) {
              await createNotification({
                userId,
                type: "upgrade_make_all_private",
                title: "Make projects private?",
                body: "You're on a paid plan. Make all your projects private in one click.",
                action: { type: "make_all_private" },
              });
            }
          }
          if (event.type === "customer.subscription.created") {
            await applyCreditDelta({
              userId,
              delta: plan.creditsMonthly,
              type: "purchase",
              description: `Subscription: ${plan.name} - Monthly credits`,
              metadata: { planKey: plan.key, subscriptionId: subscription.id },
              stripeEventId: event.id,
              idempotencyKey: `subscription-${subscription.id}-${subscription.current_period_start}`,
            });
          } else if (event.type === "customer.subscription.updated" && isUpgrade) {
            const creditsDiff = plan.creditsMonthly - (oldPlan?.creditsMonthly ?? 0);
            if (creditsDiff > 0) {
              await applyCreditDelta({
                userId,
                delta: creditsDiff,
                type: "purchase",
                description: `Subscription upgrade: ${oldPlan?.name ?? 'Previous'} → ${plan.name} - Upgrade credits`,
                metadata: { oldPlanKey: oldPlan?.key, newPlanKey: plan.key, subscriptionId: subscription.id, isUpgrade: true },
                stripeEventId: event.id,
                idempotencyKey: `subscription-upgrade-${subscription.id}-${Date.now()}`,
              });
            }
          }
          } catch (err: any) {
            if (err?.code === "23503" || err?.message?.includes("foreign key")) {
              console.error(`${event.type}: user not found or foreign key violation`, { userId, subscriptionId: subscription.id, error: err.message });
              return json({ received: true, warning: "user_not_found" });
            }
            throw err;
          }
        }
      }
    } else if (event.type === "customer.subscription.deleted") {
      const subscription = event.data.object as Stripe.Subscription;
      const userId = subscription.metadata?.user_id;
      if (userId) {
        const now = new Date().toISOString();
        await admin.from("user_subscriptions").update({
          status: "canceled",
          plan_key: "free",
          updated_at: now,
        }).eq("stripe_subscription_id", subscription.id);
        const expiryAt = computePrivateExpiryAt();
        const { totalPrivate } = await markPrivateProjectsPendingExpiry(userId, expiryAt);
        if (totalPrivate > 0) {
          const expiryLabel = expiryAt.split("T")[0];
          await createNotification({
            userId,
            type: "private_projects_pending_expiry",
            title: "Private projects expiring",
            body: `Your private projects will be removed after 30 days (on ${expiryLabel}) unless you renew. Make them public to avoid removal.`,
            action: { type: "manage_privacy", expires_at: expiryAt },
            expiresAt: expiryAt,
          });
        }
      }
    } else if (event.type === "invoice.payment_succeeded") {
      const invoice = event.data.object as Stripe.Invoice;
      if (invoice.subscription) {
        const subscriptionId = typeof invoice.subscription === "string" ? invoice.subscription : invoice.subscription.id;
        const { data: sub } = await admin.from("user_subscriptions").select("user_id, plan_key, current_period_start").eq("stripe_subscription_id", subscriptionId).maybeSingle();
        if (sub) {
          const plan = getPlan(sub.plan_key);
          if (plan) {
            const invoicePeriodStart = typeof invoice.period_start === "number" ? invoice.period_start : null;
            const subPeriodMs = sub.current_period_start ? new Date(sub.current_period_start).getTime() : NaN;
            const isRenewal = invoicePeriodStart !== null && Number.isFinite(subPeriodMs)
              ? Math.floor(subPeriodMs / 1000) === invoicePeriodStart
              : false;
            if (isRenewal) {
              await applyCreditDelta({
                userId: sub.user_id,
                delta: plan.creditsMonthly,
                type: "purchase",
                description: `Subscription: ${plan.name} - Monthly credits renewal`,
                metadata: { planKey: plan.key, subscriptionId, invoiceId: invoice.id },
                stripeEventId: event.id,
                idempotencyKey: `subscription-renewal-${subscriptionId}-${invoice.period_start}`,
              });
              await admin.from("user_subscriptions").update({
                credits_allocated_this_period: plan.creditsMonthly,
                current_period_start: safeTimestampToISO(invoice.period_start),
                current_period_end: safeTimestampToISO(invoice.period_end),
                updated_at: new Date().toISOString(),
              }).eq("stripe_subscription_id", subscriptionId);
            }
          }
        }
      }
    } else if (event.type === "charge.refunded" || event.type === "charge.dispute.created") {
      const charge = event.data.object as Stripe.Charge;
      const paymentIntentId = typeof charge.payment_intent === "string"
        ? charge.payment_intent
        : charge.payment_intent?.id ?? null;
      let userId = (charge.metadata as any)?.user_id ?? null;
      let creditsToReverse = 0;
      if (paymentIntentId) {
        const { data: rows, error } = await admin
          .from("credit_ledger")
          .select("user_id, credits_delta")
          .eq("stripe_payment_intent_id", paymentIntentId)
          .eq("type", "purchase")
          .order("created_at", { ascending: true })
          .limit(1);
        if (!error && rows && rows.length) {
          userId = userId ?? rows[0].user_id;
          creditsToReverse = Math.abs(rows[0].credits_delta);
        }
      }
      if (userId && creditsToReverse > 0) {
        await applyCreditDelta({
          userId,
          delta: -creditsToReverse,
          type: "adjustment",
          description: event.type === "charge.dispute.created"
            ? "Charge disputed - credits reversed"
            : "Payment refunded - credits reversed",
          metadata: {
            paymentIntentId,
            chargeId: charge.id,
            reason: event.type,
          },
          amountCents: typeof charge.amount_refunded === "number" && charge.amount_refunded > 0
            ? charge.amount_refunded
            : (charge.amount ?? null),
          currency: charge.currency ?? "usd",
          paymentIntentId,
          stripeEventId: event.id,
          idempotencyKey: `${event.type}:${paymentIntentId || charge.id}`,
        });
      } else {
        console.warn("refund/dispute webhook missing user or credits", { paymentIntentId, userId, creditsToReverse });
      }
    }
  } catch (err) {
    console.error("stripe webhook handler error", err);
    return json({ error: "webhook_handler_error" }, 500);
  }
  return json({ received: true });
}

async function handleGetBalance(req: Request) {
  const auth = await getUserOrService(req, { allowServiceKey: true });
  if (!auth.service && !auth.user) return json({ error: "unauthorized" }, 401);
  // allow service key to pass user_id via header
  const userId = auth.service
    ? req.headers.get("x-user-id") ?? null
    : auth.user?.id ?? null;
  if (!userId) return json({ error: "user_id_required" }, 400);
  const { data: balanceRow, error: balanceErr } = await admin
    .from("credit_balances")
    .select("balance")
    .eq("user_id", userId)
    .maybeSingle();
  if (balanceErr) return json({ error: balanceErr.message }, 500);

  let balance = coerceNumber(balanceRow?.balance ?? 0);
  // auto-initialize free trial only for brand-new users (no balance row yet)
  if (!balanceRow) {
    await admin.rpc("initialize_free_trial", { p_user_id: userId });
    balance = await getCreditBalance(userId);
  }
  return json({ balance });
}

async function handleGetCredits(req: Request) {
  const { user } = await getUserOrService(req);
  if (!user) return json({ error: "unauthorized" }, 401);
  const creditPacks = parseCreditPacks();
  const { data: balanceRow, error: balanceErr } = await admin
    .from("credit_balances")
    .select("balance")
    .eq("user_id", user.id)
    .maybeSingle();
  if (balanceErr) return json({ error: balanceErr.message }, 500);

  let balance = coerceNumber(balanceRow?.balance ?? 0);
  // auto-initialize free trial only for brand-new users (no balance row yet)
  if (!balanceRow) {
    await admin.rpc("initialize_free_trial", { p_user_id: user.id });
    balance = await getCreditBalance(user.id);
  }
  return json({ balance, packs: creditPacks });
}

async function handleGetLedger(req: Request, url: URL) {
  const { user } = await getUserOrService(req);
  if (!user) return json({ error: "unauthorized" }, 401);
  const limit = Math.max(1, Math.min(200, Number(url.searchParams.get("limit") ?? 50)));
  const { data, error } = await admin
    .from("credit_ledger")
    .select("id,type,credits_delta,description,metadata,amount_cents,currency,stripe_payment_intent_id,stripe_event_id,idempotency_key,balance_after,created_at")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) return json({ error: error.message }, 500);
  const balance = await getCreditBalance(user.id);
  return json({ balance, entries: data ?? [] });
}

async function handlePostSpend(req: Request, body: any) {
  return spendCredits({ req, body, allowService: true });
}

export async function handleBilling(req: Request, segments: string[], url: URL, rawBody: string, body: any) {
  const method = req.method.toUpperCase();
  if (segments[0] !== "billing") return null;
  // POST /billing/promo
  if (method === "POST" && segments[1] === "promo") {
    return handlePostPromo(req, body);
  }
  // GET /billing/packs
  if (method === "GET" && segments[1] === "packs") {
    const { user } = await getUserOrService(req);
    if (!user) return json({ error: "unauthorized" }, 401);
    return handleGetPacks();
  }
  // POST /billing/checkout-session
  if (method === "POST" && segments[1] === "checkout-session") {
    return handlePostCheckoutSession(req, url, body);
  }
  // POST /billing/credits/checkout
  if (method === "POST" && segments[1] === "credits" && segments[2] === "checkout") {
    return handlePostCreditsCheckoutSession(req, url, body);
  }
  // POST /billing/subscription-checkout
  if (method === "POST" && segments[1] === "subscription-checkout") {
    return handlePostSubscriptionCheckout(req, url, body);
  }
  // GET /billing/plans
  if (method === "GET" && segments[1] === "plans") {
    const { user } = await getUserOrService(req);
    if (!user) return json({ error: "unauthorized" }, 401);
    return json({ plans: Object.values(PLANS) });
  }
  // GET /billing/subscription
  if (method === "GET" && segments[1] === "subscription") {
    const { user } = await getUserOrService(req);
    if (!user) return json({ error: "unauthorized" }, 401);
    const { data: subscription, error } = await admin
      .from("user_subscriptions")
      .select("*")
      .eq("user_id", user.id)
      .maybeSingle();
    if (error) {
      console.error("subscription fetch error", error);
    }
    console.log("subscription fetch result", { userId: user.id, subscription, error: error?.message });
    return json({ subscription: subscription ?? { plan_key: "free", status: "active" } });
  }
  // POST /billing/initialize-trial
  if (method === "POST" && segments[1] === "initialize-trial") {
    const { user } = await getUserOrService(req);
    if (!user) return json({ error: "unauthorized" }, 401);
    const { error } = await admin.rpc("initialize_free_trial", { p_user_id: user.id });
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true });
  }
  // POST /billing/webhook
  if (method === "POST" && segments[1] === "webhook") {
    return handlePostWebhook(req, rawBody);
  }
  // GET /billing/balance
  if (method === "GET" && segments[1] === "balance") {
    return handleGetBalance(req);
  }
  // GET /billing/credits
  if (method === "GET" && segments[1] === "credits") {
    return handleGetCredits(req);
  }
  // GET /billing/ledger
  if (method === "GET" && segments[1] === "ledger") {
    return handleGetLedger(req, url);
  }
  // POST /billing/spend
  if (method === "POST" && segments[1] === "spend") {
    return handlePostSpend(req, body);
  }
  // POST /billing/credits/spend
  if (method === "POST" && segments[1] === "credits" && segments[2] === "spend") {
    return handlePostSpend(req, body);
  }
  // GET /billing/pricing
  if (method === "GET" && segments[1] === "pricing") {
    const { user } = await getUserOrService(req);
    if (!user) return json({ error: "unauthorized" }, 401);
    return json({ minBuildBalance: MIN_BUILD_BALANCE, payAsYouGo: true, llmPricing: parseLlmPricing() });
  }
  // POST /billing/llm-usage (per-call LLM token spend with markup)
  if (method === "POST" && segments[1] === "llm-usage") {
    const auth = await getUserOrService(req, { allowServiceKey: true });
    if (!auth.service && !auth.user) return json({ error: "unauthorized" }, 401);
    const userId = auth.service ? (body?.userId ?? body?.user_id) : auth.user?.id;
    if (!userId) return json({ error: "user_id_required" }, 400);
    const requestedModel = (body?.model ?? body?.modelName ?? "").toString().trim();
    if (!requestedModel) return json({ error: "model_required" }, 400);
    const inputTokens = Number(body?.inputTokens ?? body?.promptTokens ?? body?.prompt_tokens ?? 0);
    const outputTokens = Number(body?.outputTokens ?? body?.completionTokens ?? body?.completion_tokens ?? 0);
    if (!inputTokens && !outputTokens) return json({ error: "tokens_required" }, 400);
    const quote = quoteLlmUsage(requestedModel, inputTokens, outputTokens);
    if (!quote) return json({ error: "model_not_priced" }, 400);
    const buildId = body?.buildId ?? body?.build_id ?? null;
    const jobId = body?.jobId ?? body?.job_id ?? null;
    const idempotencyKey = body?.idempotencyKey ?? body?.requestId ?? (buildId ? `llm-usage-${buildId}-${Date.now()}` : null);
    const currentBalance = await getCreditBalance(userId);
    if (currentBalance < quote.total) {
      const { balance, drained } = await drainRemainingCredits({
        userId,
        reason: `LLM usage (insufficient funds) (${quote.requestedModel})`,
        metadata: {
          reason: "insufficient_balance",
          model: quote.requestedModel,
          inputTokens,
          outputTokens,
          totalUsd: quote.total,
          buildId,
          jobId,
        },
        idempotencyKey,
      });
      return json({ error: "insufficient_balance", balance, drained, required: quote.total }, 402);
    }
    try {
      const entry = await applyCreditDelta({
        userId,
        delta: -quote.total,
        type: "spend",
        description: `LLM usage (${quote.requestedModel})`,
        metadata: {
          model: quote.requestedModel,
          pricingModel: quote.pricing.model,
          pricingModelResolved: quote.pricingModel,
          inputTokens,
          outputTokens,
          baseUsd: quote.base,
          markupUsd: quote.markup,
          totalUsd: quote.total,
          buildId,
          jobId,
        },
        idempotencyKey,
      });
      return json({
        balance: entry.balance_after,
        charged: quote.total,
        base: quote.base,
        markup: quote.markup,
        model: quote.requestedModel,
        pricing_model: quote.pricing.model,
      });
    } catch (err: any) {
      const message = err?.message ?? "";
      if (typeof message === "string" && message.toLowerCase().includes("insufficient")) {
        const { balance, drained } = await drainRemainingCredits({
          userId,
          reason: `LLM usage (insufficient funds) (${quote.requestedModel})`,
          metadata: {
            reason: "insufficient_balance",
            model: quote.requestedModel,
            inputTokens,
            outputTokens,
            totalUsd: quote.total,
            buildId,
            jobId,
          },
          idempotencyKey,
        });
        return json({ error: "insufficient_balance", balance, drained, required: quote.total }, 402);
      }
      return json({ error: message || "llm_usage_failed" }, 500);
    }
  }
  // POST /billing/build-spend (for worker to spend credits incrementally)
  if (method === "POST" && segments[1] === "build-spend") {
    const auth = await getUserOrService(req, { allowServiceKey: true });
    if (!auth.service && !auth.user) return json({ error: "unauthorized" }, 401);
    const userId = auth.service ? (body?.userId ?? body?.user_id) : auth.user?.id;
    if (!userId) return json({ error: "user_id_required" }, 400);
    const amount = Number(body?.amount ?? 0);
    const buildId = body?.buildId ?? body?.build_id;
    if (!amount || amount <= 0) return json({ error: "amount must be > 0" }, 400);
    if (!buildId) return json({ error: "build_id_required" }, 400);
    try {
      const result = await spendBuildCredits({
        userId,
        amount,
        buildId,
        description: body?.description,
        metadata: body?.metadata,
      });
      return json({ balance: result.balance, spent: amount });
    } catch (err: any) {
      if (err?.message?.includes("insufficient")) {
        return json({ error: "insufficient_balance" }, 402);
      }
      return json({ error: err?.message ?? "spend_failed" }, 500);
    }
  }
  return null;
}
