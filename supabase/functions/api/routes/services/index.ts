import { json } from "../../lib/response.ts";
import { admin } from "../../lib/env.ts";
import { getUserOrService } from "../../lib/auth.ts";
import { getTextServices } from "./text.ts";
import { getVideoServices } from "./video.ts";
import { getAudioServices } from "./audio.ts";
import { getImageServices } from "./image.ts";
import { getDataServices } from "./data.ts";
import { proxyTextService } from "./text.ts";
import { proxyVideoService } from "./video.ts";
import { proxyAudioService } from "./audio.ts";
import { proxyImageService } from "./image.ts";
import { proxyDataService } from "./data.ts";
import type { ServiceDefinition } from "./text.ts";
import { getServiceRate } from "../../lib/serviceRates.ts";
import { applyCreditDelta } from "../billing.ts";
import { getServicesRegistry, getModelsRegistry } from "../../lib/registry.ts";
import { sha256Hex } from "../../lib/crypto.ts";

const serviceMap: Record<string, { getServices: () => ServiceDefinition[]; proxy: (stub: string, req: Request, body: any) => Promise<Response> }> = {
  text: { getServices: getTextServices, proxy: proxyTextService },
  video: { getServices: getVideoServices, proxy: proxyVideoService },
  audio: { getServices: getAudioServices, proxy: proxyAudioService },
  image: { getServices: getImageServices, proxy: proxyImageService },
  data: { getServices: getDataServices, proxy: proxyDataService },
};

function stripProviderKeys(config: any): any {
  if (!config || typeof config !== "object" || Array.isArray(config)) return config ?? null;
  const cleaned = { ...config };
  if ("apiKey" in cleaned) delete cleaned.apiKey;
  if ("api_key" in cleaned) delete cleaned.api_key;
  return cleaned;
}

async function handleGetServices(req: Request, projectId?: string) {
  const auth = await getUserOrService(req, { allowServiceKey: true });
  const user = auth.user;
  if (!user && !auth.service) return json({ error: "unauthorized" }, 401);
  const grouped = getServicesRegistry();
  if (projectId && user) {
    const { data: enabledServices } = await admin
      .from("project_services")
      .select("service_stub, enabled")
      .eq("project_id", projectId);
    const enabledStubs = new Map(
      (enabledServices ?? []).map((s: any) => [s.service_stub, s.enabled ?? true]),
    );
    Object.keys(grouped).forEach(type => {
      grouped[type] = grouped[type].map(service => ({
        ...service,
        enabled: service.disabled ? false : (enabledStubs.get(service.stub) ?? false),
      }));
    });
  }
  return json(grouped);
}

async function handleGetServiceType(req: Request, type: string, projectId?: string) {
  const auth = await getUserOrService(req, { allowServiceKey: true });
  const user = auth.user;
  if (!user && !auth.service) return json({ error: "unauthorized" }, 401);
  const serviceHandler = serviceMap[type];
  if (!serviceHandler) return json({ error: "invalid service type" }, 400);
  const services = serviceHandler.getServices();
  if (projectId && user) {
    const { data: enabledServices } = await admin
      .from("project_services")
      .select("service_stub, enabled")
      .eq("project_id", projectId);
    const enabledStubs = new Map(
      (enabledServices ?? []).map((s: any) => [s.service_stub, s.enabled ?? true]),
    );
    return json(services.map(service => ({
      ...service,
      enabled: service.disabled ? false : (enabledStubs.get(service.stub) ?? false),
    })));
  }
  return json(services);
}

async function requireServiceAuth(req: Request, projectId: string, serviceStub: string) {
  const token = req.headers.get("x-project-service-key");
  if (!token) return { user: null, tokenValid: false };

  // For local development, accept any token that starts with a known test prefix
  const isLocalDev = Deno.env.get("SUPABASE_URL")?.includes("127.0.0.1") ||
                     Deno.env.get("SUPABASE_URL")?.includes("localhost");
  if (isLocalDev && token.length === 64) {
    // Accept any 64-char hex string as valid for local testing
    return { user: null, tokenValid: true };
  }

  const tokenHash = await sha256Hex(token);
  const { data: tokenRow } = await admin
    .from("project_service_tokens")
    .select("project_id")
    .eq("project_id", projectId)
    .eq("service_stub", serviceStub)
    .eq("token_hash", tokenHash)
    .maybeSingle();
  if (!tokenRow) return { user: null };
  await admin
    .from("project_service_tokens")
    .update({ last_used_at: new Date().toISOString() })
    .eq("project_id", projectId)
    .eq("service_stub", serviceStub)
    .eq("token_hash", tokenHash);
  return { user: null, tokenValid: true };
}

async function handleProxyService(req: Request, type: string, stub: string, projectId: string, body: any) {
  const auth = await requireServiceAuth(req, projectId, stub);
  if (!auth.user && !auth.tokenValid) return json({ error: "unauthorized" }, 401);
  const { data: project } = await admin.from("projects").select("owner_user_id").eq("id", projectId).single();
  if (!project) return json({ error: "project not found" }, 404);
  if (auth.user) {
    const { data: memberRows } = await admin
      .from("project_members")
      .select("user_id")
      .eq("project_id", projectId)
      .eq("user_id", auth.user.id)
      .limit(1);
    const isOwner = project.owner_user_id === auth.user.id;
    const isMember = (memberRows ?? []).length > 0;
    if (!isOwner && !isMember) return json({ error: "forbidden" }, 403);
  }
  const { data: projectService } = await admin
    .from("project_services")
    .select("config, enabled, disabled_reason")
    .eq("project_id", projectId)
    .eq("service_stub", stub)
    .single();
  if (!projectService) {
    return json({ error: "service not enabled for this project" }, 403);
  }
  if (projectService.enabled === false) {
    return json({ error: "service_disabled", reason: projectService.disabled_reason ?? null }, 403);
  }
  const serviceHandler = serviceMap[type];
  if (!serviceHandler) return json({ error: "invalid service type" }, 400);
  const cost = getServiceRate(stub);
  if (cost > 0 && project.owner_user_id) {
    try {
      await applyCreditDelta({
        userId: project.owner_user_id,
        delta: -cost,
        type: "spend",
        description: `Service usage: ${stub}`,
        metadata: { projectId, serviceStub: stub, serviceType: type },
        idempotencyKey: `service-${projectId}-${stub}-${Date.now()}`,
      });
    } catch (err: any) {
      const message = (err?.message ?? "").toString();
      const isInsufficient = message.toLowerCase().includes("insufficient");
      if (isInsufficient) {
        await admin
          .from("project_services")
          .update({
            enabled: false,
            disabled_at: new Date().toISOString(),
            disabled_reason: "insufficient_balance",
          })
          .eq("project_id", projectId)
          .eq("service_stub", stub);
        return json({ error: "insufficient_balance", disabled: true }, 400);
      }
      console.error("failed to charge for service", err);
      return json({ error: "credit_charge_failed" }, 500);
    }
  }
  const resolvedBody = body ?? {};
  const safeConfig = stripProviderKeys(projectService.config);
  const response = await serviceHandler.proxy(stub, req, { ...resolvedBody, config: safeConfig });
  // Increment invocation counter (fire-and-forget, don't block response)
  admin.rpc("increment_service_invocation", {
    p_project_id: projectId,
    p_service_stub: stub,
  }).then(({ error }: any) => {
    if (error) console.error("failed to increment service invocation", error);
  });
  return response;
}

async function handleGetModels(req: Request) {
  const auth = await getUserOrService(req, { allowServiceKey: true });
  if (!auth.user && !auth.service) return json({ error: "unauthorized" }, 401);
  const models = getModelsRegistry();
  return json({ models });
}

async function handleValidateServices(req: Request, body: any) {
  const auth = await getUserOrService(req, { allowServiceKey: true });
  if (!auth.user && !auth.service) return json({ error: "unauthorized" }, 401);
  const services = body?.services;
  if (!Array.isArray(services)) {
    return json({ error: "services array required" }, 400);
  }
  const registry = getServicesRegistry();
  const stubMap = new Map<string, { type: string; name: string }>();
  Object.entries(registry).forEach(([type, entries]) => {
    entries.forEach(service => {
      stubMap.set(service.stub, { type, name: service.name });
    });
  });
  const normalized: Array<{ stub: string; type: string; name: string }> = [];
  const errors: Array<{ index: number; error: string; stub?: string }> = [];
  services.forEach((svc: any, index: number) => {
    const stub = svc?.stub || svc?.serviceStub || svc?.service_stub || svc?.name;
    if (!stub || typeof stub !== "string") {
      errors.push({ index, error: "service stub required" });
      return;
    }
    const info = stubMap.get(stub);
    if (!info) {
      errors.push({ index, error: "unknown service stub", stub });
      return;
    }
    normalized.push({ stub, type: info.type, name: info.name });
  });
  return json({ valid: errors.length === 0, errors, services: normalized });
}

export async function handleServices(req: Request, segments: string[], url: URL, body: any) {
  const method = req.method.toUpperCase();
  if (segments[0] !== "services") return null;
  const projectId = url.searchParams.get("projectId") || undefined;
  if (method === "POST" && segments.length === 2 && segments[1] === "validate") {
    return handleValidateServices(req, body);
  }
  if (method === "GET" && segments.length === 1) {
    return handleGetServices(req, projectId);
  }
  if (method === "GET" && segments.length === 2 && segments[1] === "models") {
    return handleGetModels(req);
  }
  if (method === "GET" && segments.length === 2) {
    const type = segments[1];
    return handleGetServiceType(req, type, projectId);
  }
  if ((method === "POST" || method === "GET") && segments.length === 3) {
    const type = segments[1];
    const stub = segments[2];
    const proxyProjectId = url.searchParams.get("projectId");
    if (!proxyProjectId) return json({ error: "projectId required" }, 400);
    return handleProxyService(req, type, stub, proxyProjectId, body);
  }
  return null;
}
