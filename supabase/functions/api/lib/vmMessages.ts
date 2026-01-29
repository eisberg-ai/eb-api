type HaikuConfig = {
  model: string;
  temperature: number;
  maxTokens: number;
};

const DEFAULT_MODEL = "claude-3-haiku-20240307";
const DEFAULT_TEMPERATURE = 0.7;
const DEFAULT_MAX_TOKENS = 64;

function loadHaikuConfig(): HaikuConfig {
  const model = (Deno.env.get("VM_HAIKU_MODEL") || DEFAULT_MODEL).trim();
  const temperatureRaw = Deno.env.get("VM_HAIKU_TEMPERATURE");
  const maxTokensRaw = Deno.env.get("VM_HAIKU_MAX_TOKENS");
  const rawTemp = temperatureRaw ? Number(temperatureRaw) : DEFAULT_TEMPERATURE;
  const temperature = Number.isFinite(rawTemp) ? Math.max(0, Math.min(1, rawTemp)) : DEFAULT_TEMPERATURE;
  const maxTokens = maxTokensRaw ? Number(maxTokensRaw) : DEFAULT_MAX_TOKENS;
  return {
    model,
    temperature,
    maxTokens: Number.isFinite(maxTokens) ? maxTokens : DEFAULT_MAX_TOKENS,
  };
}

async function callHaiku(systemPrompt: string, userPrompt: string): Promise<string> {
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY not configured");
  }
  const config = loadHaikuConfig();
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: config.model,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
      temperature: config.temperature,
      max_tokens: config.maxTokens,
    }),
  });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`anthropic api error: ${response.status} ${errorText}`);
  }
  const data = await response.json();
  const text = data.content?.[0]?.text?.trim() || "";
  if (!text) {
    throw new Error("anthropic response empty");
  }
  return text;
}

export async function generateVmAcquiredMessage(): Promise<string> {
  const systemPrompt = [
    "You write short, playful, forward-moving message that we are acquiring an agent VM.",
    "Output only the message, no quotes. Always trail the message with three dots.",
  ].join(" ");
  return callHaiku(systemPrompt, "Write the haiku now.");
}
