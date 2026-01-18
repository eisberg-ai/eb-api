export const PLATFORM_FEE_RATE = 0.15;

export type LlmPricing = {
  model: string;
  inputUsdPer1M: number;
  outputUsdPer1M: number;
};

// Map product-facing model stubs to priced provider model identifiers.
// Keep these in sync with `ALLOWED_MODELS` / UI stubs.
const MODEL_STUB_TO_PRICING_MODEL: Record<string, string> = {
  "claude-sonnet-4-5": "anthropic/claude-3-5-sonnet-20241022",
  "claude-opus-4-5": "anthropic/claude-3-opus-20240229",
  "gpt-5.2": "openai/gpt-4o-2024-11-20",
  "gemini-3-pro": "google/gemini-2.0-flash-exp",
};

// Central place to define default per-model pricing (true provider cost, per 1M tokens)
export const DEFAULT_LLM_PRICING: LlmPricing[] = [
  { model: "deepseek/deepseek-chat", inputUsdPer1M: 0.14, outputUsdPer1M: 0.28 },
  { model: "openai/gpt-4o-mini", inputUsdPer1M: 0.15, outputUsdPer1M: 0.60 },
  { model: "openai/gpt-4o-2024-11-20", inputUsdPer1M: 5.0, outputUsdPer1M: 15.0 },
  { model: "anthropic/claude-3-5-sonnet-20241022", inputUsdPer1M: 3.0, outputUsdPer1M: 15.0 },
  { model: "anthropic/claude-3-opus-20240229", inputUsdPer1M: 15.0, outputUsdPer1M: 75.0 },
  { model: "google/gemini-2.0-flash-exp", inputUsdPer1M: 0.1, outputUsdPer1M: 0.4 },
];

function hydrateFromEnv(raw: string | null): Record<string, LlmPricing> {
  const parsed: Record<string, LlmPricing> = {};
  if (!raw || !raw.trim()) return parsed;
  const trimmed = raw.trim();
  const unwrapped = (trimmed.startsWith("'") && trimmed.endsWith("'")) || (trimmed.startsWith("\"") && trimmed.endsWith("\""))
    ? trimmed.slice(1, -1)
    : trimmed;
  try {
    const val = JSON.parse(unwrapped);
    if (Array.isArray(val)) {
      for (const entry of val as LlmPricing[]) {
        const model = entry.model?.toLowerCase?.();
        if (!model) continue;
        const inputUsdPer1M = Number(entry.inputUsdPer1M ?? (entry as any).input_usd_per_1m ?? (entry as any).input_usd ?? 0);
        const outputUsdPer1M = Number(entry.outputUsdPer1M ?? (entry as any).output_usd_per_1m ?? (entry as any).output_usd ?? 0);
        if (inputUsdPer1M > 0 && outputUsdPer1M > 0) {
          parsed[model] = { model, inputUsdPer1M, outputUsdPer1M };
        }
      }
    }
  } catch (err) {
    console.error("failed to parse LLM_PRICING_JSON", err);
  }
  return parsed;
}

export function parseLlmPricing(raw?: string | null): Record<string, LlmPricing> {
  const map: Record<string, LlmPricing> = {};
  // load from env override first
  const fromEnv = hydrateFromEnv(raw ?? Deno.env.get("LLM_PRICING_JSON") ?? null);
  for (const [k, v] of Object.entries(fromEnv)) {
    map[k] = v;
  }
  // then apply defaults if missing
  for (const entry of DEFAULT_LLM_PRICING) {
    const key = entry.model.toLowerCase();
    if (!map[key]) {
      map[key] = entry;
    }
  }
  return map;
}

export function resolveLlmPricing(model: string, map: Record<string, LlmPricing>): LlmPricing | null {
  if (!model) return null;
  const normalized = model.toLowerCase();
  if (map[normalized]) return map[normalized];
  const suffix = normalized.includes("/") ? normalized.split("/").pop() : null;
  if (suffix && map[suffix]) return map[suffix];
  return null;
}

export function quoteLlmUsage(model: string, inputTokens: number, outputTokens: number) {
  const requestedModel = (model ?? "").toString().trim();
  if (!requestedModel) return null;
  const normalizedRequested = requestedModel.toLowerCase();
  const pricingModel = MODEL_STUB_TO_PRICING_MODEL[normalizedRequested] ?? requestedModel;
  const pricingMap = parseLlmPricing();
  const pricing = resolveLlmPricing(pricingModel, pricingMap);
  if (!pricing) return null;
  const input = Math.max(0, Number(inputTokens) || 0);
  const output = Math.max(0, Number(outputTokens) || 0);
  const base =
    (input / 1_000_000) * pricing.inputUsdPer1M +
    (output / 1_000_000) * pricing.outputUsdPer1M;
  const markup = base * PLATFORM_FEE_RATE;
  const total = base + markup;
  return { pricing, base, markup, total, requestedModel, pricingModel };
}
