import { admin } from "./env.ts";

export type VmMode = "stopped" | "serving" | "building";

type VmRow = {
  id: string;
  project_id: string | null;
  mode: VmMode;
  desired_build_id: string | null;
  runtime_state: string | null;
  status: string | null;
  instance_id: string | null;
  base_url: string | null;
  last_heartbeat_at: string | null;
};

const wakePath = Deno.env.get("CLOUD_RUN_WAKE_PATH") ?? "/wake";
const requestTimeoutMs = Number(Deno.env.get("CLOUD_RUN_REQUEST_TIMEOUT_MS") ?? "5000");
const heartbeatTtlSec = Number(Deno.env.get("VM_HEARTBEAT_TTL_SEC") ?? "90");
const leaseSec = Number(Deno.env.get("VM_LEASE_SEC") ?? "900");

function buildWakeUrl(baseUrl: string) {
  const trimmed = baseUrl.replace(/\/+$/g, "");
  const path = wakePath.startsWith("/") ? wakePath : `/${wakePath}`;
  return `${trimmed}${path}`;
}

async function loadAssignedVm(projectId: string) {
  const { data } = await admin
    .from("vms")
    .select("*")
    .eq("project_id", projectId)
    .order("last_heartbeat_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data ?? null;
}

async function findIdleVm(cutoffIso: string) {
  const { data } = await admin
    .from("vms")
    .select("*")
    .eq("status", "idle")
    .gte("last_heartbeat_at", cutoffIso)
    .order("last_heartbeat_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data ?? null;
}

async function claimVm(vmId: string, args: { projectId: string; mode: VmMode; buildId?: string | null }) {
  const now = new Date();
  const leaseExpires = new Date(now.getTime() + leaseSec * 1000).toISOString();
  const { data, error } = await admin
    .from("vms")
    .update({
      project_id: args.projectId,
      mode: args.mode,
      status: "busy",
      desired_build_id: args.buildId ?? null,
      runtime_state: "starting",
      lease_owner: `project:${args.projectId}`,
      lease_expires_at: leaseExpires,
      last_start_at: now.toISOString(),
      updated_at: now.toISOString(),
    })
    .eq("id", vmId)
    .eq("status", "idle")
    .select("*")
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) {
    console.warn("[vm] claim failed", { vmId, projectId: args.projectId });
    return null;
  }
  return data;
}

export async function startVm(args: { projectId: string; mode: VmMode; buildId?: string | null; agentType?: string | null }) {
  const now = new Date();
  const cutoff = new Date(now.getTime() - heartbeatTtlSec * 1000).toISOString();
  const assigned = await loadAssignedVm(args.projectId);
  if (assigned && assigned.status !== "idle") {
    throw new Error("project already has active vm");
  }
  let vm: VmRow | null = null;
  if (assigned && assigned.status === "idle") {
    vm = await claimVm(assigned.id, args);
  }
  if (!vm) {
    const idle = await findIdleVm(cutoff);
    if (!idle) throw new Error("no idle vms available");
    console.info("[vm] idle candidate", {
      id: idle.id,
      instance_id: idle.instance_id,
      base_url: idle.base_url,
      last_heartbeat_at: idle.last_heartbeat_at,
    });
    vm = await claimVm(idle.id, args);
  }
  if (!vm) throw new Error("failed to claim vm");
  if (!vm.base_url) throw new Error("assigned vm missing base_url");
  console.info("[vm] claimed", {
    id: vm.id,
    instance_id: vm.instance_id,
    base_url: vm.base_url,
    project_id: vm.project_id,
    desired_build_id: vm.desired_build_id,
  });
  const wakeUrl = buildWakeUrl(vm.base_url);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), requestTimeoutMs);
  let wakeOk = false;
  try {
    const resp = await fetch(wakeUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project_id: args.projectId,
        mode: args.mode,
        build_id: args.buildId ?? null,
        agent_type: args.agentType ?? null,
      }),
      signal: controller.signal,
    });
    wakeOk = resp.ok;
    if (!resp.ok) {
      console.error("[vm] wake failed", { projectId: args.projectId, status: resp.status });
    }
  } catch (err) {
    console.error("[vm] wake error", { projectId: args.projectId, error: err });
  } finally {
    clearTimeout(timeoutId);
  }
  return { vm: vm as VmRow, wakeOk };
}
