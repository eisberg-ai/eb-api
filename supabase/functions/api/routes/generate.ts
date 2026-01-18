import { json } from "../lib/response.ts";

async function handlePostGenerateTitle(body: any) {
  const { messages } = body;
  if (!messages || !Array.isArray(messages) || messages.length === 0) return json({ error: "messages array required" }, 400);
  const userMessages = messages.filter((m: any) => m.role === "user").map((m: any) => m.content || m.text).join(" ");
  if (!userMessages.trim()) return json({ error: "no user messages found" }, 400);
  const apiKey = Deno.env.get("DEEPSEEK_API_KEY");
  if (!apiKey) {
    console.error("DEEPSEEK_API_KEY not configured");
    return json({ error: "api key not configured" }, 500);
  }
  try {
    const response = await fetch("https://api.deepseek.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: "deepseek-chat",
        messages: [
          { role: "system", content: "generate a short 3-4 word title for this app idea. return only the title, nothing else. be concise and descriptive." },
          { role: "user", content: userMessages },
        ],
        temperature: 0.7,
        max_tokens: 20,
      }),
    });
    if (!response.ok) {
      const errorText = await response.text();
      console.error("deepseek api error:", errorText);
      return json({ error: "failed to generate title" }, 500);
    }
    const data = await response.json();
    const title = data.choices?.[0]?.message?.content?.trim() || "New Chat";
    const words = title.split(/\s+/).slice(0, 4).join(" ");
    return json({ title: words });
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
  // POST /generate-title
  if (method === "POST" && segments[0] === "generate-title") {
    return handlePostGenerateTitle(body);
  }
  // POST /generate-welcome
  if (method === "POST" && segments[0] === "generate-welcome") {
    return handlePostGenerateWelcome(body);
  }
  return null;
}
