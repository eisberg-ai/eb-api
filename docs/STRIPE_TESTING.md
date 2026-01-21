# Stripe Integration Testing Guide

## Quick Setup for Testing

### 1. Create Test Products & Prices in Stripe

Go to Stripe Dashboard → Products → Create products:

- **Junior Plan**: $25/month recurring → Copy the `price_xxxxx` ID
- **Middle Plan**: $50/month recurring → Copy the `price_xxxxx` ID
- **Senior Plan**: $100/month recurring → Copy the `price_xxxxx` ID
- **Scale 1K Plan**: $200/month recurring → Copy the `price_xxxxx` ID

### 2. Set Environment Variables

For your Supabase Edge Function, set these secrets:

```bash
STRIPE_SECRET_KEY=sk_test_xxxxx  # Your Stripe test secret key
STRIPE_WEBHOOK_SECRET=whsec_xxxxx  # From `stripe listen` output (local) or Dashboard (prod)
STRIPE_PRICE_JUNIOR=price_xxxxx
STRIPE_PRICE_MIDDLE=price_xxxxx
STRIPE_PRICE_SENIOR=price_xxxxx
STRIPE_PRICE_SCALE_1K=price_xxxxx
```

### 3. Start Stripe CLI (for local testing)

```bash
stripe listen --forward-to localhost:54321/functions/v1/api/billing/webhook
```

Copy the `whsec_xxxxx` from the output and set it as `STRIPE_WEBHOOK_SECRET`.

### 4. Test Flow

1. Open your app and click "Upgrade Plan" or open Pricing Modal
2. Click "Upgrade to [Plan]" button
3. You'll be redirected to Stripe Checkout
4. Use test card: `4242 4242 4242 4242` (any future date, any CVC)
5. Complete checkout
6. You'll be redirected back to your app
7. Check webhook logs in Stripe CLI terminal
8. Verify credits were added via `/billing/balance` endpoint

### 5. Test Webhook Events

You can trigger test events with Stripe CLI:

```bash
# Test subscription created
stripe trigger customer.subscription.created

# Test invoice payment
stripe trigger invoice.payment_succeeded

# Test subscription updated
stripe trigger customer.subscription.updated
```

## Production Setup

1. Create production products/prices in Stripe Dashboard
2. Set production webhook endpoint: `https://your-domain.com/billing/webhook`
3. Copy webhook signing secret from Dashboard
4. Update environment variables with production values
5. Test with real payment method (then refund if needed)

## Troubleshooting

- **"plan_not_configured" error**: Make sure you set the `STRIPE_PRICE_*` env vars
- **Webhook not working**: Check that `STRIPE_WEBHOOK_SECRET` matches the CLI output
- **Credits not added**: Check webhook logs and database `credit_ledger` table
- **Checkout redirect fails**: Verify `BILLING_SUCCESS_URL` is set correctly











