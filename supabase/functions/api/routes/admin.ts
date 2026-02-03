import { json } from "../lib/response.ts";
import { admin } from "../lib/env.ts";
import { getUserOrService, isAdminUser } from "../lib/auth.ts";
import { generateCode, normalizeCode } from "../lib/codes.ts";

type CountFilter = { column: string; value: string };

async function requireAdmin(req: Request) {
  const auth = await getUserOrService(req, { allowServiceKey: true });
  if (auth.service) return { ok: true as const, user: null };
  if (!auth.user) return { ok: false as const, response: json({ error: "unauthorized" }, 401) };
  const isAdmin = await isAdminUser(auth.user.id);
  if (!isAdmin) return { ok: false as const, response: json({ error: "forbidden" }, 403) };
  return { ok: true as const, user: auth.user };
}

function parsePagination(url: URL, defaults = { limit: 20, max: 100 }) {
  const limitRaw = Number(url.searchParams.get("limit") ?? defaults.limit);
  const offsetRaw = Number(url.searchParams.get("offset") ?? 0);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), defaults.max) : defaults.limit;
  const offset = Number.isFinite(offsetRaw) ? Math.max(offsetRaw, 0) : 0;
  return { limit, offset };
}

async function requireAdminStream(url: URL) {
  const accessToken = url.searchParams.get("access_token") ?? "";
  if (!accessToken) return { ok: false as const, response: json({ error: "unauthorized" }, 401) };
  const { data: { user }, error } = await admin.auth.getUser(accessToken);
  if (error || !user) return { ok: false as const, response: json({ error: "unauthorized" }, 401) };
  const isAdmin = await isAdminUser(user.id);
  if (!isAdmin) return { ok: false as const, response: json({ error: "forbidden" }, 403) };
  return { ok: true as const, user };
}

async function insertCodeRow(table: "invite_codes" | "promo_codes", code: string, payload: Record<string, unknown>) {
  const { data, error } = await admin.from(table).insert({ code, ...payload }).select("*").single();
  if (error) throw error;
  return data as Record<string, unknown>;
}

async function generateUniqueCode(table: "invite_codes" | "promo_codes", payload: Record<string, unknown>) {
  const maxAttempts = 5;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const code = generateCode(8);
    try {
      return await insertCodeRow(table, code, payload);
    } catch (err: any) {
      if (err?.code !== "23505") {
        console.error("code insert failed", err);
        throw err;
      }
    }
  }
  throw new Error("code_insert_failed");
}

async function countRows(table: string, column: string, filter?: CountFilter) {
  let query = admin.from(table).select(column, { count: "exact", head: true });
  if (filter) query = query.eq(filter.column, filter.value);
  const { count, error } = await query;
  if (error) {
    console.error("[admin] count error", { table, filter, error });
    return 0;
  }
  return count ?? 0;
}

async function getSummaryData() {
  const [projectsTotal, buildsTotal, jobsTotal] = await Promise.all([
    countRows("projects", "id"),
    countRows("builds", "id"),
    countRows("jobs", "job_id"),
  ]);

  let usersTotal = 0;
  try {
    const { data } = await admin.auth.admin.listUsers({ page: 1, perPage: 1 });
    usersTotal = data?.total ?? data?.users?.length ?? 0;
  } catch (err) {
    console.error("[admin] listUsers error", err);
  }

  const jobStatuses = ["queued", "claimed", "running", "succeeded", "failed", "killed"];
  const buildStatuses = ["pending", "queued", "running", "succeeded", "failed"];
  const projectStatuses = ["draft", "active", "building", "failed", "archived", "staged"];

  const jobStatusCounts: Record<string, number> = {};
  const buildStatusCounts: Record<string, number> = {};
  const projectStatusCounts: Record<string, number> = {};

  await Promise.all(jobStatuses.map(async (status) => {
    jobStatusCounts[status] = await countRows("jobs", "job_id", { column: "status", value: status });
  }));
  await Promise.all(buildStatuses.map(async (status) => {
    buildStatusCounts[status] = await countRows("builds", "id", { column: "status", value: status });
  }));
  await Promise.all(projectStatuses.map(async (status) => {
    projectStatusCounts[status] = await countRows("projects", "id", { column: "status", value: status });
  }));

  let creditBalanceTotal = 0;
  try {
    const { data } = await admin.from("credit_balances").select("balance");
    creditBalanceTotal = (data ?? []).reduce((sum, row: any) => sum + Number(row.balance || 0), 0);
  } catch (err) {
    console.error("[admin] credit balance total error", err);
  }

  let creditTotals = { purchase: 0, spend: 0, adjustment: 0 };
  try {
    const { data } = await admin.from("credit_ledger").select("credits_delta,type");
    (data ?? []).forEach((row: any) => {
      const delta = Number(row.credits_delta || 0);
      if (row.type === "purchase") creditTotals.purchase += delta;
      if (row.type === "spend") creditTotals.spend += Math.abs(delta);
      if (row.type === "adjustment") creditTotals.adjustment += delta;
    });
  } catch (err) {
    console.error("[admin] credit ledger totals error", err);
  }

  return {
    counts: {
      projects: projectsTotal,
      builds: buildsTotal,
      jobs: jobsTotal,
      users: usersTotal,
    },
    statusCounts: {
      jobs: jobStatusCounts,
      builds: buildStatusCounts,
      projects: projectStatusCounts,
    },
    credits: {
      balanceTotal: creditBalanceTotal,
      purchasedTotal: creditTotals.purchase,
      spentTotal: creditTotals.spend,
      adjustmentTotal: creditTotals.adjustment,
    },
  };
}

async function handleSummary() {
  return json(await getSummaryData());
}

async function getProjectsData(limit: number, offset: number) {
  const { data, error, count } = await admin
    .from("projects")
    .select("id,name,owner_user_id,status,latest_build_id,created_at,updated_at", { count: "exact" })
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) throw error;
  return { rows: data ?? [], total: count ?? 0 };
}

async function handleProjects(url: URL) {
  const { limit, offset } = parsePagination(url);
  try {
    return json(await getProjectsData(limit, offset));
  } catch (err: any) {
    return json({ error: err.message }, 500);
  }
}

async function getBuildsData(limit: number, offset: number) {
  const { data, error, count } = await admin
    .from("builds")
    .select("id,project_id,job_id,version_number,status,artifacts,started_at,ended_at,created_at,updated_at,error_code,error_message", { count: "exact" })
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) throw error;
  return { rows: data ?? [], total: count ?? 0 };
}

async function handleBuilds(url: URL) {
  const { limit, offset } = parsePagination(url);
  try {
    return json(await getBuildsData(limit, offset));
  } catch (err: any) {
    return json({ error: err.message }, 500);
  }
}

async function getJobsData(limit: number, offset: number) {
  const { data, error, count } = await admin
    .from("jobs")
    .select("job_id,project_id,status,worker_id,claimed_at,last_heartbeat,created_at,updated_at", { count: "exact" })
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) throw error;
  return { rows: data ?? [], total: count ?? 0 };
}

async function handleJobs(url: URL) {
  const { limit, offset } = parsePagination(url);
  try {
    return json(await getJobsData(limit, offset));
  } catch (err: any) {
    return json({ error: err.message }, 500);
  }
}

async function getUsersData(limit: number, offset: number) {
  const page = Math.floor(offset / limit) + 1;
  const { data, error } = await admin.auth.admin.listUsers({ page, perPage: limit });
  if (error) throw error;
  const users = data?.users ?? [];
  const userIds = users.map((u) => u.id);
  const { data: profiles } = userIds.length
    ? await admin
      .from("user_profiles")
      .select("user_id,user_type,created_at,access_status,access_status_updated_at,approved_at,approved_by,denied_at,denied_by")
      .in("user_id", userIds)
    : { data: [] };
  const profileMap = new Map((profiles ?? []).map((row: any) => [row.user_id, row]));
  const rows = users.map((user) => {
    const profile = profileMap.get(user.id);
    return {
      id: user.id,
      email: user.email,
      created_at: user.created_at,
      last_sign_in_at: user.last_sign_in_at,
      user_type: profile?.user_type ?? "user",
      profile_created_at: profile?.created_at ?? null,
      access_status: profile?.access_status ?? "pending",
      access_status_updated_at: profile?.access_status_updated_at ?? null,
      approved_at: profile?.approved_at ?? null,
      approved_by: profile?.approved_by ?? null,
      denied_at: profile?.denied_at ?? null,
      denied_by: profile?.denied_by ?? null,
    };
  });
  const total = data?.total ?? rows.length;
  return { rows, total };
}

async function handleUsers(url: URL) {
  const { limit, offset } = parsePagination(url);
  try {
    return json(await getUsersData(limit, offset));
  } catch (err: any) {
    return json({ error: err.message }, 500);
  }
}

async function getCreditsData(limit: number, offset: number) {
  const { data, error, count } = await admin
    .from("credit_ledger")
    .select("id,user_id,type,credits_delta,description,metadata,balance_after,created_at", { count: "exact" })
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) throw error;
  return { rows: data ?? [], total: count ?? 0 };
}

async function handleCredits(url: URL) {
  const { limit, offset } = parsePagination(url);
  try {
    return json(await getCreditsData(limit, offset));
  } catch (err: any) {
    return json({ error: err.message }, 500);
  }
}

async function getInvitesData(limit: number, offset: number) {
  const { data, error, count } = await admin
    .from("invite_codes")
    .select("code,created_by,created_by_role,created_by_email,created_at,redeemed_by,redeemed_email,redeemed_at,uses_count,max_uses", { count: "exact" })
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) throw error;
  return { rows: data ?? [], total: count ?? 0 };
}

async function handleInvites(url: URL) {
  const { limit, offset } = parsePagination(url);
  try {
    return json(await getInvitesData(limit, offset));
  } catch (err: any) {
    return json({ error: err.message }, 500);
  }
}

async function handleCreateInvite(user: any, body: any) {
  const now = new Date().toISOString();
  const payload = {
    created_by: user?.id ?? null,
    created_by_role: "admin",
    created_by_email: user?.email?.toLowerCase?.() ?? null,
    created_at: now,
    updated_at: now,
    max_uses: 1,
    uses_count: 0,
  };
  const rawCode = (body?.code ?? "").toString();
  const provided = normalizeCode(rawCode);
  try {
    const row = provided
      ? await insertCodeRow("invite_codes", provided, payload)
      : await generateUniqueCode("invite_codes", payload);
    return json({ code: row.code, createdAt: row.created_at ?? now });
  } catch (err: any) {
    if (err?.code === "23505") return json({ error: "invite_code_exists" }, 409);
    return json({ error: err?.message ?? "invite_create_failed" }, 500);
  }
}

async function getPromoCodesData(limit: number, offset: number) {
  const { data, error, count } = await admin
    .from("promo_codes")
    .select("code,credits,created_by,created_by_email,created_at,redeemed_by,redeemed_email,redeemed_at", { count: "exact" })
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) throw error;
  return { rows: data ?? [], total: count ?? 0 };
}

async function handlePromoCodes(url: URL) {
  const { limit, offset } = parsePagination(url);
  try {
    return json(await getPromoCodesData(limit, offset));
  } catch (err: any) {
    return json({ error: err.message }, 500);
  }
}

async function handleCluster(url: URL) {
  const { limit, offset } = parsePagination(url);
  try {
    return json(await getClusterData(limit, offset));
  } catch (err: any) {
    return json({ error: err.message }, 500);
  }
}

async function handleCreatePromoCode(user: any, body: any) {
  const rawAmount = body?.amount ?? body?.credits ?? body?.value ?? body?.usd ?? body?.dollars ?? null;
  const credits = Number(rawAmount);
  if (!Number.isFinite(credits) || credits <= 0) {
    return json({ error: "promo_amount_required" }, 400);
  }
  const now = new Date().toISOString();
  const payload = {
    credits,
    created_by: user?.id ?? null,
    created_by_email: user?.email?.toLowerCase?.() ?? null,
    created_at: now,
    updated_at: now,
  };
  const rawCode = (body?.code ?? "").toString();
  const provided = normalizeCode(rawCode);
  try {
    const row = provided
      ? await insertCodeRow("promo_codes", provided, payload)
      : await generateUniqueCode("promo_codes", payload);
    return json({ code: row.code, credits: row.credits ?? credits, createdAt: row.created_at ?? now });
  } catch (err: any) {
    if (err?.code === "23505") return json({ error: "promo_code_exists" }, 409);
    return json({ error: err?.message ?? "promo_create_failed" }, 500);
  }
}

async function handleUserApproval(user: any, userId: string, body: any) {
  const rawStatus = (body?.status ?? body?.accessStatus ?? body?.access_status ?? "").toString().toLowerCase();
  const status = rawStatus === "approved" || rawStatus === "denied" ? rawStatus : null;
  if (!status) return json({ error: "access_status_required" }, 400);
  const now = new Date().toISOString();
  const updates: Record<string, unknown> = {
    user_id: userId,
    access_status: status,
    access_status_updated_at: now,
    updated_at: now,
  };
  if (status === "approved") {
    updates.approved_at = now;
    updates.approved_by = user?.id ?? null;
    updates.denied_at = null;
    updates.denied_by = null;
  } else {
    updates.denied_at = now;
    updates.denied_by = user?.id ?? null;
    updates.approved_at = null;
    updates.approved_by = null;
  }
  const { error } = await admin
    .from("user_profiles")
    .upsert(updates, { onConflict: "user_id" });
  if (error) return json({ error: error.message }, 500);
  return json({ ok: true, userId, accessStatus: status });
}

function resolveAdminTab(raw: string | null): string {
  const tab = (raw ?? "").toLowerCase();
  const allowed = new Set(["projects", "builds", "jobs", "users", "credits", "invites", "promo-codes", "cluster"]);
  return allowed.has(tab) ? tab : "projects";
}

async function getClusterData(limit: number, offset: number) {
  const { data, error, count } = await admin
    .from("vms")
    .select("id,project_id,instance_id,base_url,status,runtime_state,desired_build_id,lease_owner,lease_expires_at,last_heartbeat_at,created_at,updated_at", { count: "exact" })
    .order("last_heartbeat_at", { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) throw error;
  return { rows: data ?? [], total: count ?? 0 };
}

async function getTabData(tab: string, limit: number, offset: number) {
  switch (tab) {
    case "builds":
      return await getBuildsData(limit, offset);
    case "jobs":
      return await getJobsData(limit, offset);
    case "cluster":
      return await getClusterData(limit, offset);
    case "users":
      return await getUsersData(limit, offset);
    case "credits":
      return await getCreditsData(limit, offset);
    case "invites":
      return await getInvitesData(limit, offset);
    case "promo-codes":
      return await getPromoCodesData(limit, offset);
    case "projects":
    default:
      return await getProjectsData(limit, offset);
  }
}

async function handleAdminStream(req: Request, url: URL) {
  const gate = await requireAdminStream(url);
  if (!gate.ok) return gate.response;
  const tab = resolveAdminTab(url.searchParams.get("tab"));
  const { limit, offset } = parsePagination(url);
  const pollMsRaw = Number(url.searchParams.get("poll_ms") ?? "5000");
  const pollMs = Number.isFinite(pollMsRaw) ? Math.min(20000, Math.max(2000, pollMsRaw)) : 5000;
  const encoder = new TextEncoder();
  let lastSummary = "";
  let lastTabPayload = "";
  const signal = req.signal;
  const stream = new ReadableStream({
    start(controller) {
      const send = (event: string, data: string) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${data}\n\n`));
      };
      const sendComment = (text: string) => {
        controller.enqueue(encoder.encode(`: ${text}\n\n`));
      };
      sendComment("connected");
      const loop = async () => {
        while (!signal.aborted) {
          try {
            const summaryData = await getSummaryData();
            const summaryPayload = JSON.stringify(summaryData);
            if (summaryPayload !== lastSummary) {
              send("summary", summaryPayload);
              lastSummary = summaryPayload;
            }
            const tabData = await getTabData(tab, limit, offset);
            const tabPayload = JSON.stringify({ tab, ...tabData });
            if (tabPayload !== lastTabPayload) {
              send("tab", tabPayload);
              lastTabPayload = tabPayload;
            }
          } catch (err) {
            console.error("[admin] stream error", err);
            send("error", JSON.stringify({ message: (err as Error).message }));
          }
          await new Promise((resolve) => setTimeout(resolve, pollMs));
        }
        controller.close();
      };
      loop().catch((err) => {
        console.error("[admin] stream loop failed", err);
        controller.close();
      });
    },
    cancel() {
      // noop
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

export async function handleAdmin(req: Request, segments: string[], url: URL, body: any) {
  if (segments[0] !== "admin") return null;
  if (req.method === "GET" && segments[1] === "stream") return handleAdminStream(req, url);
  const gate = await requireAdmin(req);
  if (!gate.ok) return gate.response;
  if (req.method === "GET" && segments[1] === "summary") return handleSummary();
  if (req.method === "GET" && segments[1] === "projects") return handleProjects(url);
  if (req.method === "GET" && segments[1] === "builds") return handleBuilds(url);
  if (req.method === "GET" && segments[1] === "jobs") return handleJobs(url);
  if (req.method === "GET" && segments[1] === "users") return handleUsers(url);
  if (req.method === "GET" && segments[1] === "credits") return handleCredits(url);
  if (req.method === "GET" && segments[1] === "invites") return handleInvites(url);
  if (req.method === "POST" && segments[1] === "invites") return handleCreateInvite(gate.user, body);
  if (req.method === "GET" && segments[1] === "promo-codes") return handlePromoCodes(url);
  if (req.method === "POST" && segments[1] === "promo-codes") return handleCreatePromoCode(gate.user, body);
  if (req.method === "GET" && segments[1] === "cluster") return handleCluster(url);
  if (req.method === "POST" && segments[1] === "users" && segments[3] === "approval") {
    return handleUserApproval(gate.user, segments[2], body);
  }
  // GET /admin/leaderboard - Agent performance leaderboard
  if (req.method === "GET" && segments[1] === "leaderboard") return handleLeaderboard(url);
  // PATCH /admin/leaderboard/{buildId}/scores - Update build scores
  if (req.method === "PATCH" && segments[1] === "leaderboard" && segments[3] === "scores") {
    return handleUpdateBuildScores(segments[2], body);
  }
  return json({ error: "not found" }, 404);
}

// Leaderboard: Compare agent performance across builds
async function handleLeaderboard(url: URL) {
  const { limit, offset } = parsePagination(url, { limit: 50, max: 200 });
  const agentVersion = url.searchParams.get("agent_version");
  const model = url.searchParams.get("model");
  const status = url.searchParams.get("status") || "succeeded";

  let query = admin
    .from("builds")
    .select(`
      id,
      project_id,
      agent_version,
      model,
      status,
      started_at,
      ended_at,
      usage_summary,
      langfuse_trace_id,
      scores,
      artifacts,
      projects!inner(id, name, owner_user_id)
    `)
    .eq("status", status)
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (agentVersion) query = query.eq("agent_version", agentVersion);
  if (model) query = query.eq("model", model);

  const { data, error, count } = await query;
  if (error) {
    console.error("[admin] leaderboard error", error);
    return json({ error: error.message }, 500);
  }

  // Calculate duration and format response
  const builds = (data ?? []).map((b: any) => {
    const startedAt = b.started_at ? new Date(b.started_at).getTime() : null;
    const endedAt = b.ended_at ? new Date(b.ended_at).getTime() : null;
    const durationS = startedAt && endedAt ? (endedAt - startedAt) / 1000 : null;
    const usage = b.usage_summary ?? {};
    return {
      id: b.id,
      project_id: b.project_id,
      project_name: b.projects?.name ?? null,
      agent_version: b.agent_version,
      model: b.model,
      status: b.status,
      started_at: b.started_at,
      ended_at: b.ended_at,
      duration_s: durationS,
      // Usage metrics
      total_input_tokens: usage.total_input_tokens ?? null,
      total_output_tokens: usage.total_output_tokens ?? null,
      total_calls: usage.total_calls ?? null,
      total_cost_usd: usage.total_charged_usd ?? null,
      // Links
      langfuse_trace_id: b.langfuse_trace_id,
      langfuse_url: b.langfuse_trace_id
        ? `https://cloud.langfuse.com/trace/${b.langfuse_trace_id}`
        : null,
      preview_url: b.artifacts?.web ?? null,
      // Scores
      scores: b.scores ?? {},
    };
  });

  return json({ builds, total: count ?? builds.length, limit, offset });
}

async function handleUpdateBuildScores(buildId: string, body: any) {
  const scores = body?.scores ?? body;
  if (!scores || typeof scores !== "object") {
    return json({ error: "scores object required" }, 400);
  }
  // Validate score values (1-5)
  const validKeys = ["design", "functionality", "polish"];
  const cleanScores: Record<string, number> = {};
  for (const key of validKeys) {
    if (key in scores) {
      const val = Number(scores[key]);
      if (!Number.isFinite(val) || val < 1 || val > 5) {
        return json({ error: `${key} must be 1-5` }, 400);
      }
      cleanScores[key] = val;
    }
  }
  const { data, error } = await admin
    .from("builds")
    .update({ scores: cleanScores })
    .eq("id", buildId)
    .select("id, scores")
    .single();
  if (error) return json({ error: error.message }, 500);
  return json({ build: data });
}
