import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient, type SupabaseClient, type User } from "https://esm.sh/@supabase/supabase-js@2.45.2";

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

if (!supabaseUrl || !serviceKey) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
}

const admin = createClient(supabaseUrl, serviceKey);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,Authorization,apikey,X-Client-Info",
};

const withCors = (resp: Response): Response => {
  const headers = new Headers(resp.headers);
  for (const [key, value] of Object.entries(corsHeaders)) {
    if (!headers.has(key)) headers.set(key, value);
  }
  return new Response(resp.body, { status: resp.status, headers });
};

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function functionSegment(url: URL): string {
  const parts = url.pathname.split("/").filter(Boolean);
  const functionsIdx = parts.indexOf("functions");
  if (functionsIdx !== -1 && parts[functionsIdx + 1] === "v1") {
    return parts[functionsIdx + 2] ?? "";
  }
  return parts[0] ?? "";
}

function parseAppFunction(name: string) {
  const match = /^app_([0-9a-fA-F-]{36})__([A-Za-z0-9_-]+)$/.exec(name);
  if (!match) return null;
  const appId = match[1];
  const fn = match[2];
  const appIdNorm = appId.replace(/-/g, "");
  return { appId, appIdNorm, fn };
}

async function getUserFromRequest(req: Request): Promise<User | null> {
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) return null;
  const token = authHeader.replace("Bearer ", "");
  const { data, error } = await admin.auth.getUser(token);
  if (data?.user) return data.user;
  if (error) {
    console.error("auth getUser failed", error);
  }
  return null;
}

async function isMember(appId: string, userId: string): Promise<boolean> {
  const { data, error } = await admin
    .from("app_users")
    .select("role")
    .eq("app_id", appId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) {
    console.error("app_users lookup failed", error);
    return false;
  }
  return Boolean(data);
}

export type UserlandDb = Pick<SupabaseClient, "from" | "rpc">;

export type UserlandContext = {
  appId: string;
  appIdNorm: string;
  functionName: string;
  user: User;
  input: unknown;
  db: UserlandDb;
  req: Request;
};

export type UserlandHandler = (ctx: UserlandContext) => Promise<Response | unknown>;

export function createUserlandHandler(handler: UserlandHandler) {
  return async (req: Request): Promise<Response> => {
    if (req.method.toUpperCase() === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    try {
      const url = new URL(req.url);
      const fnSegment = functionSegment(url);
      const parsed = parseAppFunction(fnSegment);
      if (!parsed) {
        return withCors(json({ error: "invalid_function_name" }, 400));
      }

      const user = await getUserFromRequest(req);
      if (!user) {
        return withCors(json({ error: "unauthorized" }, 401));
      }

      const member = await isMember(parsed.appId, user.id);
      if (!member) {
        return withCors(json({ error: "not_a_member" }, 403));
      }

      const shouldReadBody = req.method.toUpperCase() !== "GET" && req.method.toUpperCase() !== "HEAD";
      const rawBody = shouldReadBody ? await req.text() : "";
      let input: unknown = {};
      if (rawBody) {
        try {
          input = JSON.parse(rawBody);
        } catch (_err) {
          return withCors(json({ error: "invalid_json" }, 400));
        }
      }

      const schemaName = `app_${parsed.appIdNorm}`;
      const scoped = admin.schema(schemaName);
      const db: UserlandDb = {
        from: scoped.from.bind(scoped),
        rpc: scoped.rpc.bind(scoped),
      };

      const result = await handler({
        appId: parsed.appId,
        appIdNorm: parsed.appIdNorm,
        functionName: parsed.fn,
        user,
        input,
        db,
        req,
      });

      if (result instanceof Response) {
        return withCors(result);
      }
      return withCors(json(result));
    } catch (err) {
      console.error("userland handler error", err);
      return withCors(json({ error: "internal_error" }, 500));
    }
  };
}

export function serveUserland(handler: UserlandHandler) {
  serve(createUserlandHandler(handler));
}
