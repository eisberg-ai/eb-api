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

const serviceMap: Record<string, { getServices: () => ServiceDefinition[]; proxy: (stub: string, req: Request, body: any) => Promise<Response> }> = {
  text: { getServices: getTextServices, proxy: proxyTextService },
  video: { getServices: getVideoServices, proxy: proxyVideoService },
  audio: { getServices: getAudioServices, proxy: proxyAudioService },
  image: { getServices: getImageServices, proxy: proxyImageService },
  data: { getServices: getDataServices, proxy: proxyDataService },
};

async function handleGetServices(req: Request, projectId?: string) {
  const { user } = await getUserOrService(req);
  const grouped = getServicesRegistry();
  if (projectId && user) {
    const { data: enabledServices } = await admin
      .from("project_services")
      .select("service_stub")
      .eq("project_id", projectId);
    const enabledStubs = new Set((enabledServices ?? []).map((s: any) => s.service_stub));
    Object.keys(grouped).forEach(type => {
      grouped[type] = grouped[type].map(service => ({
        ...service,
        enabled: enabledStubs.has(service.stub),
      }));
    });
  }
  return json(grouped);
}

async function handleGetServiceType(req: Request, type: string, projectId?: string) {
  const { user } = await getUserOrService(req);
  const serviceHandler = serviceMap[type];
  if (!serviceHandler) return json({ error: "invalid service type" }, 400);
  const services = serviceHandler.getServices();
  if (projectId && user) {
    const { data: enabledServices } = await admin
      .from("project_services")
      .select("service_stub")
      .eq("project_id", projectId);
    const enabledStubs = new Set((enabledServices ?? []).map((s: any) => s.service_stub));
    return json(services.map(service => ({
      ...service,
      enabled: enabledStubs.has(service.stub),
    })));
  }
  return json(services);
}

async function handleProxyService(req: Request, type: string, stub: string, projectId: string) {
  const { user } = await getUserOrService(req);
  if (!user) return json({ error: "unauthorized" }, 401);
  const { data: project } = await admin.from("projects").select("owner_user_id").eq("id", projectId).single();
  if (!project) return json({ error: "project not found" }, 404);
  const { data: projectService } = await admin
    .from("project_services")
    .select("config")
    .eq("project_id", projectId)
    .eq("service_stub", stub)
    .single();
  if (!projectService) {
    return json({ error: "service not enabled for this project" }, 403);
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
      console.error("failed to charge for service", err);
      return json({ error: "insufficient_balance" }, 400);
    }
  }
  const rawBody = await req.text().catch(() => "");
  const body = rawBody ? JSON.parse(rawBody) : {};
  const response = await serviceHandler.proxy(stub, req, { ...body, config: projectService.config });
  return response;
}

async function handleGetModels(req: Request) {
  await getUserOrService(req);
  const models = getModelsRegistry();
  return json({ models });
}

export async function handleServices(req: Request, segments: string[], url: URL, body: any) {
  const method = req.method.toUpperCase();
  if (segments[0] !== "services") return null;
  const projectId = url.searchParams.get("projectId") || undefined;
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
    return handleProxyService(req, type, stub, proxyProjectId);
  }
  return null;
}










