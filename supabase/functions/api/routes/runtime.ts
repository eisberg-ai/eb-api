import { json } from "../lib/response.ts";
import { getUserOrService } from "../lib/auth.ts";
import { defaultAgentVersion } from "../lib/env.ts";
import { DEFAULT_MODEL } from "../lib/project.ts";

export async function handleRuntime(req: Request, segments: string[]) {
  const method = req.method.toUpperCase();
  if (segments[0] !== "runtime") return null;
  if (method !== "GET") return json({ error: "method_not_allowed" }, 405);
  const auth = await getUserOrService(req, { allowServiceKey: true });
  if (!auth.user && !auth.service) return json({ error: "unauthorized" }, 401);
  return json({
    default_agent_version: defaultAgentVersion,
    default_model: DEFAULT_MODEL,
  });
}
