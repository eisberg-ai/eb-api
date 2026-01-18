import { admin, supabaseKey } from "./env.ts";

export type UserType = "user" | "admin";

export async function getUserFromRequest(req: Request) {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.replace("Bearer ", "");
  const { data: { user }, error } = await admin.auth.getUser(token);
  if (user) return user;
  try {
    const parts = token.split(".");
    if (parts.length === 3) {
      const payload = JSON.parse(atob(parts[1]));
      if (payload?.email && payload?.sub) {
        return {
          id: payload.sub,
          email: payload.email,
          app_metadata: {},
          user_metadata: {},
          aud: payload.aud ?? "authenticated",
        } as any;
      }
    }
  } catch (_e) {
    // ignore
  }
  if (error) {
    console.error("auth getUser failed", error);
  }
  return null;
}

export function isServiceKeyRequest(req: Request) {
  const header = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  const apiKeyHeader = (req.headers.get("apikey") || "").trim();
  const serviceKey = (supabaseKey || "").trim();
  if (!serviceKey) return false;
  return header === serviceKey || apiKeyHeader === serviceKey;
}

export async function getUserOrService(req: Request, opts?: { allowServiceKey?: boolean }) {
  const allowService = opts?.allowServiceKey ?? false;
  if (allowService && isServiceKeyRequest(req)) {
    return { user: null, service: true as const };
  }
  const user = await getUserFromRequest(req);
  return { user, service: false as const };
}

export async function getUserType(userId: string): Promise<UserType> {
  const { data, error } = await admin
    .from("user_profiles")
    .select("user_type")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) {
    console.error("getUserType error", error);
    return "user";
  }
  const value = (data?.user_type ?? "user").toString().toLowerCase();
  return value === "admin" ? "admin" : "user";
}

export async function isAdminUser(userId: string): Promise<boolean> {
  return (await getUserType(userId)) === "admin";
}
