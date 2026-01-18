export type ModelLevel = "low" | "medium" | "high" | "extra_high";

const MODEL_ALIAS_MAP: Record<ModelLevel, string> = {
  low: "deepseek-model-2",
  medium: "deepseek-model-3",
  high: "deepseek-model-4",
  extra_high: "deepseek-model-5",
};

export function resolveModelAlias(level?: string | null, explicit?: string | null): string | null {
  if (explicit) return explicit;
  const normalized = (level || "").toLowerCase() as ModelLevel;
  if (normalized && MODEL_ALIAS_MAP[normalized]) return MODEL_ALIAS_MAP[normalized];
  return null;
}
