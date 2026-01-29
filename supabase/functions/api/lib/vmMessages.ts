type HaikuConfig = {
  model: string;
  temperature: number;
  maxTokens: number;
};

const DEFAULT_MODEL = "claude-3-haiku-20240307";
const DEFAULT_TEMPERATURE = 1.15;
const DEFAULT_MAX_TOKENS = 64;

function loadHaikuConfig(): HaikuConfig {
  const model = (Deno.env.get("VM_HAIKU_MODEL") || DEFAULT_MODEL).trim();
  const temperatureRaw = Deno.env.get("VM_HAIKU_TEMPERATURE");
  const maxTokensRaw = Deno.env.get("VM_HAIKU_MAX_TOKENS");
  const temperature = temperatureRaw ? Number(temperatureRaw) : DEFAULT_TEMPERATURE;
  const maxTokens = maxTokensRaw ? Number(maxTokensRaw) : DEFAULT_MAX_TOKENS;
  return {
    model,
    temperature: Number.isFinite(temperature) ? temperature : DEFAULT_TEMPERATURE,
    maxTokens: Number.isFinite(maxTokens) ? maxTokens : DEFAULT_MAX_TOKENS,
  };
}

export async function generateVmAcquiredMessage(): Promise<string> {
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY not configured");
  }
  const config = loadHaikuConfig();
  const systemPrompt = [
    "You write short, playful, forward-moving haiku (5-7-5).",
    "Signal that momentum is about to begin.",
    "Avoid words like VM, agent, acquired, build, or starting.",
    "Avoid redundancy with status lines like 'Acquiring agent VM...'.",
    "Output only the haiku, exactly 3 lines, no quotes.",
  ].join(" ");
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
      messages: [{ role: "user", content: "Write the haiku now." }],
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
