import { json } from "../lib/response.ts";
import { getUserOrService } from "../lib/auth.ts";

const APP_NAMES_SYSTEM_PROMPT = `You are a world-class app naming expert. Generate exactly 5 unique, iconic app names for the given app idea.

Your names should be:
- BRANDABLE: Easy to say, spell, and remember
- ICONIC: Could become household names like Spotify, Instagram, Notion, Figma
- CREATIVE: Use techniques like:
  - Invented words (Spotify, Hulu, Roku)
  - Word combinations/portmanteaus (Instagram, Pinterest, Snapchat)
  - Modified spellings (Lyft, Tumblr, Flickr)
  - Short punchy words (Slack, Zoom, Stripe)
  - Evocative single words (Notion, Craft, Bear)
  - Playful sounds (TikTok, Bumble, Figma)

Rules:
- Each name should be 1-2 words max
- No generic descriptive names like "Workout Tracker" or "Recipe App"
- Make them feel like real startup names
- Return ONLY the 5 names, one per line, nothing else`;

async function callHaiku(systemPrompt: string, userPrompt: string, maxTokens = 100): Promise<string> {
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY not configured");
  }
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-3-haiku-20240307",
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
      temperature: 0.9,
      max_tokens: maxTokens,
    }),
  });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`anthropic api error: ${response.status} ${errorText}`);
  }
  const data = await response.json();
  return data.content?.[0]?.text?.trim() || "";
}

async function handlePostGenerateAppNames(body: any) {
  const { description } = body;
  if (!description || typeof description !== "string" || !description.trim()) {
    return json({ error: "description required" }, 400);
  }
  try {
    const result = await callHaiku(APP_NAMES_SYSTEM_PROMPT, description.trim());
    const names = result
      .split("\n")
      .map((line: string) => line.trim())
      .filter((line: string) => line.length > 0 && line.length < 30)
      .slice(0, 5);
    if (names.length === 0) {
      return json({ error: "failed to generate names" }, 500);
    }
    return json({ names });
  } catch (error) {
    console.error("generate app names error:", error);
    return json({ error: "internal server error" }, 500);
  }
}

async function handlePostGenerateTitle(body: any) {
  const { messages } = body;
  if (!messages || !Array.isArray(messages) || messages.length === 0) return json({ error: "messages array required" }, 400);
  const userMessages = messages.filter((m: any) => m.role === "user").map((m: any) => m.content || m.text).join(" ");
  if (!userMessages.trim()) return json({ error: "no user messages found" }, 400);
  try {
    // Use Haiku for title generation too
    const result = await callHaiku(APP_NAMES_SYSTEM_PROMPT, userMessages);
    const names = result
      .split("\n")
      .map((line: string) => line.trim())
      .filter((line: string) => line.length > 0 && line.length < 30);
    const title = names[0] || "New App";
    return json({ title });
  } catch (error) {
    console.error("generate title error:", error);
    return json({ error: "internal server error" }, 500);
  }
}

async function handlePostGenerateWelcome(body: any) {
  const apiKey = Deno.env.get("DEEPSEEK_API_KEY");
  if (!apiKey) {
    console.error("DEEPSEEK_API_KEY not configured");
    return json({ error: "api key not configured" }, 500);
  }
  const userPrompt = body?.prompt as string | undefined;
  const friendlyPrompt = [
    "Write a short, friendly welcome message for a product builder that just opened the app.",
    "Keep it under 40 words. Be encouraging and actionable.",
    "If a prompt is provided, briefly acknowledge it. Otherwise, invite them to describe what they want to build.",
  ].join(" ");
  try {
    const response = await fetch("https://api.deepseek.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: "deepseek-chat",
        messages: [
          { role: "system", content: friendlyPrompt },
          userPrompt
            ? { role: "user", content: `Context: ${userPrompt}` }
            : { role: "user", content: "No prompt provided; just say hi and ask what to build." },
        ],
        temperature: 0.6,
        max_tokens: 120,
      }),
    });
    if (!response.ok) {
      const errorText = await response.text();
      console.error("deepseek welcome api error:", errorText);
      return json({ error: "failed to generate welcome" }, 500);
    }
    const data = await response.json();
    const content = data.choices?.[0]?.message?.content?.trim();
    if (!content) return json({ error: "empty welcome" }, 500);
    return json({ message: content });
  } catch (error) {
    console.error("generate welcome error:", error);
    return json({ error: "internal server error" }, 500);
  }
}

export async function handleGenerate(req: Request, segments: string[], _url: URL, body: any) {
  const method = req.method.toUpperCase();
  // POST /generate-app-names
  if (method === "POST" && segments[0] === "generate-app-names") {
    const { user } = await getUserOrService(req);
    if (!user) return json({ error: "unauthorized" }, 401);
    return handlePostGenerateAppNames(body);
  }
  // POST /generate-title
  if (method === "POST" && segments[0] === "generate-title") {
    const { user } = await getUserOrService(req);
    if (!user) return json({ error: "unauthorized" }, 401);
    return handlePostGenerateTitle(body);
  }
  // POST /generate-welcome
  if (method === "POST" && segments[0] === "generate-welcome") {
    const { user } = await getUserOrService(req);
    if (!user) return json({ error: "unauthorized" }, 401);
    return handlePostGenerateWelcome(body);
  }
  return null;
}
