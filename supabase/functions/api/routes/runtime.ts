import { json } from "../lib/response.ts";
import { defaultAgentVersion } from "../lib/env.ts";
import { DEFAULT_MODEL } from "../lib/project.ts";

export async function handleRuntime(req: Request, segments: string[]) {
  const method = req.method.toUpperCase();
  if (segments[0] !== "runtime") return null;
  if (method !== "GET") return json({ error: "method_not_allowed" }, 405);
  return json({
    default_agent_version: defaultAgentVersion,
    default_model: DEFAULT_MODEL,
  });
}
