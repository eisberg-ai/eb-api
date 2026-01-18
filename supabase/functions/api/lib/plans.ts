// subscription plan definitions
export type PlanKey = 'free' | 'plus' | 'pro' | 'max';

export interface Plan {
  key: PlanKey;
  name: string;
  priceMonthly: number;
  creditsMonthly: number; // dollar amount of credits per month
  stripePriceId?: string; // stripe price id for subscription
  features: string[];
  creditPurchaseBonus?: number; // bonus multiplier for credit purchases (e.g., 0.1 = 10% extra)
}

export const PLANS: Record<PlanKey, Plan> = {
  free: {
    key: 'free',
    name: 'Free',
    priceMonthly: 0,
    creditsMonthly: 2.5, // $2.50 free credits on signup
    features: [
      '$2.50 credits included',
      'Share apps via App Clips',
    ],
  },
  plus: {
    key: 'plus',
    name: 'Plus',
    priceMonthly: 20,
    creditsMonthly: 20, // $20 credits/month
    stripePriceId: Deno.env.get('STRIPE_PRICE_PLUS') || undefined,
    features: [
      '$20 worth of credits/month',
      'Share apps via App Clips',
      'Vibecode Sandbox',
      'Sandbox projects',
      'App Store submission',
    ],
  },
  pro: {
    key: 'pro',
    name: 'Pro',
    priceMonthly: 50,
    creditsMonthly: 55, // $55 credits/month (10% bonus)
    stripePriceId: Deno.env.get('STRIPE_PRICE_PRO') || undefined,
    features: [
      '$55 worth of credits/month',
      'Share apps via App Clips',
      'Vibecode Sandbox',
      'SSH to Cursor',
      'Sandbox projects',
      'App Store submission',
      'Download source code',
    ],
  },
  max: {
    key: 'max',
    name: 'Max',
    priceMonthly: 200,
    creditsMonthly: 220, // $220 credits/month (10% bonus)
    stripePriceId: Deno.env.get('STRIPE_PRICE_MAX') || undefined,
    creditPurchaseBonus: 0.1, // 10% bonus on additional credit purchases
    features: [
      '$220 worth of credits/month',
      'Share apps via App Clips',
      'Vibecode Sandbox',
      'SSH to Cursor',
      'Sandbox projects',
      'App Store submission',
      'Download source code',
      '24/7 Priority support',
    ],
  },
};

export function getPlan(key: PlanKey | string | null): Plan | null {
  if (!key) return null;
  return PLANS[key as PlanKey] ?? null;
}











