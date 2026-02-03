import { admin } from "./env.ts";

export type VmMode = "stopped" | "serving" | "building";

/**
 * Rewrite localhost URLs to host.docker.internal for local dev.
 * Supabase edge functions run in Docker, so localhost refers to the container,
 * not the host machine. We detect localhost URLs and rewrite them.
 */
function rewriteUrlForDocker(url: string): string {
  if (url.includes("localhost") || url.includes("127.0.0.1")) {
    return url
      .replace("http://localhost", "http://host.docker.internal")
      .replace("http://127.0.0.1", "http://host.docker.internal");
  }
  return url;
}

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
const claimMaxAttempts = Number(Deno.env.get("VM_CLAIM_MAX_ATTEMPTS") ?? "3");
const wakeMaxAttempts = Number(Deno.env.get("VM_WAKE_MAX_ATTEMPTS") ?? "3");
const retryDelayMs = Number(Deno.env.get("VM_RETRY_DELAY_MS") ?? "500");

function buildWakeUrl(baseUrl: string) {
  const trimmed = rewriteUrlForDocker(baseUrl.replace(/\/+$/g, ""));
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

async function pruneStaleVms(cutoffIso: string) {
  const now = new Date().toISOString();
  // Prune VMs with:
  // - stale heartbeat (null or older than cutoff)
  // - expired lease (lease_expires_at in the past)
  const { data, error } = await admin
    .from("vms")
    .update({
      status: "error",
      runtime_state: "error",
      project_id: null,
      desired_build_id: null,
      lease_owner: null,
      lease_expires_at: null,
      last_shutdown_at: now,
      updated_at: now,
    })
    .in("status", ["idle", "busy", "starting"])
    .or(`last_heartbeat_at.is.null,last_heartbeat_at.lt.${cutoffIso},lease_expires_at.lt.${now}`)
    .select("id, instance_id");
  if (error) {
    console.error("[vm] prune stale failed", { error: error.message });
    return;
  }
  if (data && data.length > 0) {
    console.warn("[vm] pruned stale vms", { count: data.length });
  }
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

async function releaseVm(vmId: string, reason?: string) {
  const now = new Date().toISOString();
  const { error } = await admin
    .from("vms")
    .update({
      status: "idle",
      runtime_state: "serving",
      project_id: null,
      desired_build_id: null,
      lease_owner: null,
      lease_expires_at: null,
      last_shutdown_at: now,
      updated_at: now,
    })
    .eq("id", vmId);
  if (error) {
    console.error("[vm] release failed", { vmId, reason, error: error.message });
  }
}

export async function startVm(args: { projectId: string; mode: VmMode; buildId?: string | null; agentType?: string | null }) {
  const now = new Date();
  const cutoff = new Date(now.getTime() - heartbeatTtlSec * 1000).toISOString();
  await pruneStaleVms(cutoff);
  const assigned = await loadAssignedVm(args.projectId);
  if (assigned && assigned.status !== "idle") {
    throw new Error("project already has active vm");
  }

  // Claim with retry logic - another request may claim the VM before us
  let vm: VmRow | null = null;
  for (let attempt = 1; attempt <= claimMaxAttempts; attempt++) {
    // Try previously assigned VM first
    if (assigned && assigned.status === "idle" && !vm) {
      vm = await claimVm(assigned.id, args);
      if (vm) break;
    }
    // Find and claim an idle VM
    const idle = await findIdleVm(cutoff);
    if (!idle) {
      if (attempt < claimMaxAttempts) {
        console.info("[vm] no idle vms, retrying", { attempt, maxAttempts: claimMaxAttempts });
        await new Promise((r) => setTimeout(r, retryDelayMs));
        continue;
      }
      throw new Error("no idle vms available");
    }
    console.info("[vm] idle candidate", {
      id: idle.id,
      instance_id: idle.instance_id,
      base_url: idle.base_url,
      last_heartbeat_at: idle.last_heartbeat_at,
      attempt,
    });
    vm = await claimVm(idle.id, args);
    if (vm) break;
    if (attempt < claimMaxAttempts) {
      console.info("[vm] claim failed (race), retrying", { vmId: idle.id, attempt });
      await new Promise((r) => setTimeout(r, retryDelayMs));
    }
  }
  if (!vm) throw new Error("failed to claim vm after retries");
  if (!vm.base_url) {
    await releaseVm(vm.id, "missing_base_url");
    throw new Error("assigned vm missing base_url");
  }
  console.info("[vm] claimed", {
    id: vm.id,
    instance_id: vm.instance_id,
    base_url: vm.base_url,
    project_id: vm.project_id,
    desired_build_id: vm.desired_build_id,
  });
  // Skip wake for testing VM lifecycle (set VM_SKIP_WAKE=1)
  const skipWake = Deno.env.get("VM_SKIP_WAKE") === "1";
  if (skipWake) {
    console.info("[vm] skipping wake (VM_SKIP_WAKE=1)", { vmId: vm.id });
    return { vm: vm as VmRow, wakeOk: true };
  }

  // Wake with retry logic
  const wakeUrl = buildWakeUrl(vm.base_url);
  let wakeOk = false;
  let wakeError: string | null = null;

  for (let attempt = 1; attempt <= wakeMaxAttempts; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), requestTimeoutMs);
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
      if (resp.ok) {
        break;
      }
      wakeError = `vm_wake_failed:${resp.status}`;
      console.warn("[vm] wake failed", { projectId: args.projectId, status: resp.status, attempt });
    } catch (err) {
      wakeError = `vm_wake_failed:${(err as Error).message || "unknown"}`;
      console.warn("[vm] wake error", { projectId: args.projectId, error: err, attempt });
    } finally {
      clearTimeout(timeoutId);
    }
    if (attempt < wakeMaxAttempts) {
      console.info("[vm] retrying wake", { attempt, maxAttempts: wakeMaxAttempts });
      await new Promise((r) => setTimeout(r, retryDelayMs));
    }
  }

  if (!wakeOk) {
    await releaseVm(vm.id, wakeError ?? "vm_wake_failed");
    throw new Error(wakeError ?? "vm_wake_failed");
  }
  return { vm: vm as VmRow, wakeOk };
}
