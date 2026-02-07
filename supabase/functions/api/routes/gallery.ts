import { admin } from "../lib/env.ts";
import { json } from "../lib/response.ts";
import { getUserOrService } from "../lib/auth.ts";
import { getProjectAccess } from "../lib/access.ts";

const DEFAULT_LIMIT = 12;
const MAX_LIMIT = 100;
const GALLERY_PROJECT_SELECT =
  "id, name, owner_user_id, updated_at, created_at, is_public, is_gallery, gallery_slug, gallery, latest_build_id, status";

type GallerySort = "recent" | "votes";

const normalizeQuery = (value: string) =>
  value.trim().toLowerCase().replace(/\s+/g, " ");

const parseListParam = (value: string | null) => {
  if (!value) return [];
  return value
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
};

const parseSortParam = (value: string | null): GallerySort => {
  const normalized = (value ?? "").trim().toLowerCase();
  return normalized === "votes" ? "votes" : "recent";
};

const clampLimit = (raw: string | null) => {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, parsed));
};

async function hashQuery(query: string): Promise<string> {
  const data = new TextEncoder().encode(query);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest)).map((b) =>
    b.toString(16).padStart(2, "0")
  ).join("");
}

async function embedText(query: string): Promise<number[] | null> {
  const apiKey = Deno.env.get("OPENAI_API_KEY") ??
    Deno.env.get("OPENAI_EMBEDDINGS_API_KEY");
  if (!apiKey) return null;
  const model = Deno.env.get("OPENAI_EMBEDDINGS_MODEL") ??
    "text-embedding-3-small";
  const input = query.length > 6000 ? query.slice(0, 6000) : query;
  try {
    const response = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        input,
      }),
    });
    if (!response.ok) {
      const errorText = await response.text();
      console.error("[gallery] embeddings error", response.status, errorText);
      return null;
    }
    const data = await response.json();
    const embedding = data?.data?.[0]?.embedding;
    return Array.isArray(embedding) ? embedding : null;
  } catch (err) {
    console.error("[gallery] embeddings request failed", err);
    return null;
  }
}

const pickGalleryValue = (gallery: any, key: string, fallback?: any) => {
  if (!gallery || typeof gallery !== "object") return fallback;
  const value = gallery[key];
  return value === undefined ? fallback : value;
};

const normalizeGallery = (gallery: any) => {
  if (!gallery || typeof gallery !== "object") return {};
  return gallery;
};

const buildGalleryProjectsQuery = () =>
  admin
    .from("projects")
    .select(GALLERY_PROJECT_SELECT)
    .eq("is_public", true)
    .neq("status", "draft")
    .neq("status", "archived");

const cleanText = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const nameFromMetadata = (metadata: unknown): string | null => {
  if (!metadata || typeof metadata !== "object") return null;
  const obj = metadata as Record<string, unknown>;
  return cleanText(obj.display_name) ??
    cleanText(obj.displayName) ??
    cleanText(obj.full_name) ??
    cleanText(obj.fullName) ??
    cleanText(obj.name) ??
    cleanText(obj.username);
};

const nameFromEmail = (email: string | null | undefined): string | null => {
  if (!email) return null;
  const localPart = email.split("@")[0]?.trim();
  if (!localPart) return null;
  const normalized = localPart.replace(/[._-]+/g, " ").trim();
  return normalized || localPart;
};

const fallbackAuthorLabel = (
  ownerUserId: string | null | undefined,
): string => {
  if (!ownerUserId) return "Unknown";
  return `User ${ownerUserId.slice(0, 8)}`;
};

const parseTimestamp = (value: unknown): number => {
  if (!value) return 0;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : 0;
};

const parseVoteCount = (value: unknown): number => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};

async function loadAuthorNames(
  ownerUserIds: string[],
): Promise<Map<string, string>> {
  const uniqueOwnerIds = Array.from(
    new Set(
      ownerUserIds.filter((id) => typeof id === "string" && id.length > 0),
    ),
  );
  const authorNames = new Map<string, string>();
  if (uniqueOwnerIds.length === 0) return authorNames;

  const { data: profileRows, error: profileError } = await admin
    .from("user_profiles")
    .select("user_id, metadata")
    .in("user_id", uniqueOwnerIds);
  if (profileError) {
    console.error(
      "[gallery] failed to load user profiles for authors",
      profileError,
    );
    throw profileError;
  }

  for (const row of profileRows ?? []) {
    const ownerId = (row as any)?.user_id as string | null;
    if (!ownerId) continue;
    const resolved = nameFromMetadata((row as any)?.metadata);
    if (resolved) authorNames.set(ownerId, resolved);
  }

  const unresolvedOwnerIds = uniqueOwnerIds.filter((ownerId) =>
    !authorNames.has(ownerId)
  );
  if (unresolvedOwnerIds.length === 0) return authorNames;

  const authLookups = await Promise.all(
    unresolvedOwnerIds.map(async (ownerId) => {
      try {
        const { data, error } = await admin.auth.admin.getUserById(ownerId);
        if (error) {
          console.error(
            "[gallery] failed auth user lookup for author",
            ownerId,
            error,
          );
          return [ownerId, null] as const;
        }
        const metadata = data?.user?.user_metadata as
          | Record<string, unknown>
          | null;
        const resolved = nameFromMetadata(metadata) ??
          nameFromEmail(data?.user?.email ?? null);
        return [ownerId, resolved] as const;
      } catch (err) {
        console.error("[gallery] unexpected author lookup error", ownerId, err);
        return [ownerId, null] as const;
      }
    }),
  );

  for (const [ownerId, resolved] of authLookups) {
    if (resolved) authorNames.set(ownerId, resolved);
  }

  return authorNames;
}

async function loadVoteCountMap(
  projectIds: string[],
): Promise<Map<string, number>> {
  const uniqueProjectIds = Array.from(
    new Set(projectIds.filter((id) => typeof id === "string" && id.length > 0)),
  );
  const voteCountByProjectId = new Map<string, number>();
  if (uniqueProjectIds.length === 0) return voteCountByProjectId;

  const { data, error } = await admin.rpc("gallery_vote_totals", {
    project_ids: uniqueProjectIds,
  });
  if (error) {
    console.error("[gallery] failed to load vote totals", error);
    throw error;
  }

  for (const row of data ?? []) {
    const projectId = (row as any)?.project_id as string | null;
    if (!projectId) continue;
    voteCountByProjectId.set(
      projectId,
      parseVoteCount((row as any)?.vote_count),
    );
  }

  return voteCountByProjectId;
}

async function loadViewerVotes(
  projectIds: string[],
  viewerUserId: string,
): Promise<Set<string>> {
  const uniqueProjectIds = Array.from(
    new Set(projectIds.filter((id) => typeof id === "string" && id.length > 0)),
  );
  if (uniqueProjectIds.length === 0) return new Set<string>();

  const { data, error } = await admin
    .from("gallery_project_votes")
    .select("project_id")
    .eq("user_id", viewerUserId)
    .in("project_id", uniqueProjectIds);
  if (error) {
    console.error("[gallery] failed to load viewer votes", error);
    throw error;
  }
  return new Set(
    (data ?? []).map((row: any) => row.project_id).filter(Boolean),
  );
}

const sortGalleryProjects = (
  projects: any[],
  sort: GallerySort,
  voteCountByProjectId: Map<string, number>,
) => {
  const sorted = [...projects];
  if (sort === "votes") {
    sorted.sort((a, b) => {
      const voteDiff = (voteCountByProjectId.get(b.id) ?? 0) -
        (voteCountByProjectId.get(a.id) ?? 0);
      if (voteDiff !== 0) return voteDiff;
      const updatedDiff = parseTimestamp(b.updated_at) -
        parseTimestamp(a.updated_at);
      if (updatedDiff !== 0) return updatedDiff;
      return String(a.id).localeCompare(String(b.id));
    });
    return sorted;
  }
  sorted.sort((a, b) => {
    const updatedDiff = parseTimestamp(b.updated_at) -
      parseTimestamp(a.updated_at);
    if (updatedDiff !== 0) return updatedDiff;
    return String(a.id).localeCompare(String(b.id));
  });
  return sorted;
};

const mapProjectToGalleryItem = (
  project: any,
  build: any,
  authorNamesByOwnerId: Map<string, string>,
  voteCountByProjectId: Map<string, number>,
  viewerVotes: Set<string>,
  options?: { includeGallery?: boolean },
) => {
  const gallery = normalizeGallery(project.gallery);
  const ownerUserId = cleanText(project.owner_user_id);
  const authorName = ownerUserId
    ? authorNamesByOwnerId.get(ownerUserId) ?? fallbackAuthorLabel(ownerUserId)
    : fallbackAuthorLabel(null);

  const item: Record<string, unknown> = {
    id: project.id,
    slug: project.gallery_slug ?? project.id,
    title: project.name ?? "Untitled",
    summary: pickGalleryValue(gallery, "summary", ""),
    categories: pickGalleryValue(gallery, "categories", []),
    tags: pickGalleryValue(gallery, "tags", []),
    icon_url: pickGalleryValue(
      gallery,
      "icon_url",
      pickGalleryValue(gallery, "icon", null),
    ),
    hero_url: pickGalleryValue(
      gallery,
      "hero_url",
      pickGalleryValue(gallery, "hero", null),
    ),
    author_id: ownerUserId ?? null,
    author: authorName,
    updated_at: project.updated_at ?? null,
    created_at: project.created_at ?? null,
    preview_url: build?.artifacts?.web ?? null,
    version_number: build?.version_number ?? null,
    vote_count: voteCountByProjectId.get(project.id) ?? 0,
    viewer_has_voted: viewerVotes.has(project.id),
  };
  if (options?.includeGallery) {
    item.gallery = gallery;
  }
  return item;
};

async function resolveGalleryProject(slugOrId: string) {
  const { data: slugMatch, error: slugError } =
    await buildGalleryProjectsQuery()
      .eq("gallery_slug", slugOrId)
      .maybeSingle();
  if (slugError) throw slugError;
  if (slugMatch) return slugMatch;

  const { data: idMatch, error: idError } = await buildGalleryProjectsQuery()
    .eq("id", slugOrId)
    .maybeSingle();
  if (idError) throw idError;
  return idMatch;
}

async function loadVoteState(projectId: string, viewerUserId: string) {
  const [voteCountByProjectId, viewerVotes] = await Promise.all([
    loadVoteCountMap([projectId]),
    loadViewerVotes([projectId], viewerUserId),
  ]);
  return {
    vote_count: voteCountByProjectId.get(projectId) ?? 0,
    viewer_has_voted: viewerVotes.has(projectId),
  };
}

const matchesTaxonomyFilters = (
  project: any,
  tags: string[],
  categories: string[],
) => {
  if (tags.length === 0 && categories.length === 0) return true;
  const gallery = normalizeGallery(project?.gallery);
  if (tags.length > 0) {
    const itemTags = Array.isArray(pickGalleryValue(gallery, "tags", []))
      ? pickGalleryValue(gallery, "tags", [])
      : [];
    if (!tags.some((tag) => itemTags.includes(tag))) return false;
  }
  if (categories.length > 0) {
    const itemCategories =
      Array.isArray(pickGalleryValue(gallery, "categories", []))
        ? pickGalleryValue(gallery, "categories", [])
        : [];
    if (!categories.some((category) => itemCategories.includes(category))) {
      return false;
    }
  }
  return true;
};

async function handleGetGallery(req: Request, url: URL) {
  const { user } = await getUserOrService(req);
  if (!user) return json({ error: "unauthorized" }, 401);
  const limit = clampLimit(url.searchParams.get("limit"));
  const offset = Math.max(
    0,
    Number(url.searchParams.get("offset") ?? "0") || 0,
  );
  const search = (url.searchParams.get("search") ?? "").trim();
  const tags = parseListParam(url.searchParams.get("tags"));
  const categories = parseListParam(url.searchParams.get("categories"));
  const sort = parseSortParam(url.searchParams.get("sort"));

  let projects: any[] = [];
  let total = 0;
  let voteCountByProjectId = new Map<string, number>();

  const requiresUnpagedQuery = sort === "votes" || tags.length > 0 ||
    categories.length > 0;
  if (requiresUnpagedQuery) {
    let unpagedQuery = buildGalleryProjectsQuery().order("updated_at", {
      ascending: false,
    });
    if (search) {
      unpagedQuery = unpagedQuery.ilike("name", `%${search}%`);
    }
    const { data: allProjects, error: unpagedError } = await unpagedQuery;
    if (unpagedError) return json({ error: unpagedError.message }, 500);
    const filteredProjects = (allProjects ?? []).filter((project: any) =>
      matchesTaxonomyFilters(project, tags, categories)
    );
    total = filteredProjects.length;

    if (sort === "votes") {
      voteCountByProjectId = await loadVoteCountMap(
        filteredProjects.map((project: any) => project.id),
      );
    }

    const sortedProjects = sortGalleryProjects(
      filteredProjects,
      sort,
      voteCountByProjectId,
    );
    projects = sortedProjects.slice(offset, offset + limit);
  } else {
    let countQuery = admin
      .from("projects")
      .select("id", { count: "exact", head: true })
      .eq("is_public", true)
      .neq("status", "draft")
      .neq("status", "archived");
    if (search) {
      countQuery = countQuery.ilike("name", `%${search}%`);
    }
    const { count, error: countError } = await countQuery;
    if (countError) return json({ error: countError.message }, 500);
    total = count ?? 0;

    let pagedQuery = buildGalleryProjectsQuery()
      .order("updated_at", { ascending: false })
      .range(offset, offset + limit - 1);
    if (search) {
      pagedQuery = pagedQuery.ilike("name", `%${search}%`);
    }
    const { data: pagedProjects, error: pagedError } = await pagedQuery;
    if (pagedError) return json({ error: pagedError.message }, 500);
    projects = pagedProjects ?? [];
  }

  const projectIds = projects.map((project: any) => project.id).filter(Boolean);
  if (voteCountByProjectId.size === 0) {
    voteCountByProjectId = await loadVoteCountMap(projectIds);
  }

  const viewerVotes = await loadViewerVotes(projectIds, user.id);

  const buildIds = projects
    .map((project: any) => project.latest_build_id)
    .filter(Boolean);
  const buildMap = new Map<string, any>();
  if (buildIds.length > 0) {
    const { data: builds } = await admin
      .from("builds")
      .select("id, artifacts, version_number")
      .in("id", buildIds);
    (builds ?? []).forEach((b: any) => buildMap.set(b.id, b));
  }

  const ownerUserIds = projects
    .map((project: any) => project.owner_user_id)
    .filter((value: unknown): value is string =>
      typeof value === "string" && value.length > 0
    );
  const authorNamesByOwnerId = await loadAuthorNames(ownerUserIds);

  const items = projects.map((project: any) => {
    const build = project.latest_build_id
      ? buildMap.get(project.latest_build_id)
      : null;
    return mapProjectToGalleryItem(
      project,
      build,
      authorNamesByOwnerId,
      voteCountByProjectId,
      viewerVotes,
    );
  });
  return json({ items, total, limit, offset, sort });
}

async function handleGetGalleryItem(req: Request, slugOrId: string) {
  const { user } = await getUserOrService(req);
  if (!user) return json({ error: "unauthorized" }, 401);
  try {
    const project = await resolveGalleryProject(slugOrId);
    if (!project) return json({ error: "not found" }, 404);
    return buildGalleryDetailResponse(project, user.id);
  } catch (err: any) {
    return json({ error: err?.message ?? "failed_to_load_gallery_item" }, 500);
  }
}

async function buildGalleryDetailResponse(project: any, viewerUserId: string) {
  let build = null;
  if (project.latest_build_id) {
    const { data: buildRow } = await admin
      .from("builds")
      .select("id, artifacts, version_number")
      .eq("id", project.latest_build_id)
      .maybeSingle();
    build = buildRow;
  }

  const ownerUserIds = typeof project.owner_user_id === "string"
    ? [project.owner_user_id]
    : [];
  const [authorNamesByOwnerId, voteCountByProjectId, viewerVotes] =
    await Promise.all([
      loadAuthorNames(ownerUserIds),
      loadVoteCountMap([project.id]),
      loadViewerVotes([project.id], viewerUserId),
    ]);

  return json({
    item: mapProjectToGalleryItem(
      project,
      build,
      authorNamesByOwnerId,
      voteCountByProjectId,
      viewerVotes,
      { includeGallery: true },
    ),
  });
}

async function handleVoteGalleryItem(req: Request, slugOrId: string) {
  const { user } = await getUserOrService(req);
  if (!user) return json({ error: "unauthorized" }, 401);

  let project: any;
  try {
    project = await resolveGalleryProject(slugOrId);
  } catch (err: any) {
    return json({ error: err?.message ?? "failed_to_resolve_project" }, 500);
  }
  if (!project) return json({ error: "not found" }, 404);

  const { error } = await admin
    .from("gallery_project_votes")
    .insert({
      project_id: project.id,
      user_id: user.id,
      created_at: new Date().toISOString(),
    });

  if (error && (error as any)?.code !== "23505") {
    return json({ error: error.message }, 500);
  }

  const voteState = await loadVoteState(project.id, user.id);
  return json({
    ok: true,
    project_id: project.id,
    ...voteState,
  });
}

async function handleUnvoteGalleryItem(req: Request, slugOrId: string) {
  const { user } = await getUserOrService(req);
  if (!user) return json({ error: "unauthorized" }, 401);

  let project: any;
  try {
    project = await resolveGalleryProject(slugOrId);
  } catch (err: any) {
    return json({ error: err?.message ?? "failed_to_resolve_project" }, 500);
  }
  if (!project) return json({ error: "not found" }, 404);

  const { error } = await admin
    .from("gallery_project_votes")
    .delete()
    .eq("project_id", project.id)
    .eq("user_id", user.id);
  if (error) return json({ error: error.message }, 500);

  const voteState = await loadVoteState(project.id, user.id);
  return json({
    ok: true,
    project_id: project.id,
    ...voteState,
  });
}

async function handleLookupGalleryCache(
  req: Request,
  projectId: string,
  body: any,
) {
  const { user } = await getUserOrService(req);
  if (!user) return json({ error: "unauthorized" }, 401);
  const access = await getProjectAccess(projectId, user.id);
  if (!access.project) return json({ error: "not found" }, 404);
  if (!access.isOwner && !access.isWorkspaceMember && !access.isAdmin) {
    return json({ error: "forbidden" }, 403);
  }
  const queryTextRaw = body?.query ?? body?.prompt ?? "";
  const queryText = typeof queryTextRaw === "string" ? queryTextRaw.trim() : "";
  if (!queryText) return json({ error: "query required" }, 400);
  const normalized = normalizeQuery(queryText);
  const queryHash = await hashQuery(normalized);
  const thresholdRaw = Number(
    body?.threshold ?? body?.min_score ?? body?.minScore ?? 0.86,
  );
  const threshold = Number.isFinite(thresholdRaw) ? thresholdRaw : 0.86;
  const limit = clampLimit(body?.limit?.toString?.() ?? null);

  const { data: exactMatches, error: exactErr } = await admin
    .from("app_gallery_cache")
    .select(
      "id, project_id, query_text, query_hash, response, response_summary, model, agent_version, template_version, created_at",
    )
    .eq("project_id", projectId)
    .eq("query_hash", queryHash)
    .order("created_at", { ascending: false })
    .limit(1);
  if (exactErr) {
    return json({ error: exactErr.message }, 500);
  }
  const exact = exactMatches?.[0];
  if (exact) {
    return json({
      hit: {
        ...exact,
        score: 1,
        match: "exact",
      },
    });
  }

  const embedding = await embedText(normalized);
  if (!embedding) {
    return json({ hit: null, reason: "embeddings_unavailable" });
  }

  const { data: matches, error } = await admin.rpc("match_gallery_cache", {
    embedding,
    match_project_id: projectId,
    match_threshold: threshold,
    match_count: limit,
  });
  if (error) return json({ error: error.message }, 500);
  const match = Array.isArray(matches) && matches.length > 0
    ? matches[0]
    : null;
  return json({ hit: match });
}

async function handleStoreGalleryCache(
  req: Request,
  projectId: string,
  body: any,
) {
  const { service } = await getUserOrService(req, { allowServiceKey: true });
  if (!service) return json({ error: "unauthorized" }, 401);
  const queryTextRaw = body?.query ?? body?.prompt ?? "";
  const queryText = typeof queryTextRaw === "string" ? queryTextRaw.trim() : "";
  const response = body?.response ?? null;
  if (!queryText) return json({ error: "query required" }, 400);
  if (!response || typeof response !== "object") {
    return json({ error: "response required" }, 400);
  }

  const normalized = normalizeQuery(queryText);
  const queryHash = await hashQuery(normalized);
  const embedding = await embedText(normalized);
  const now = new Date().toISOString();

  const { data, error } = await admin
    .from("app_gallery_cache")
    .insert({
      project_id: projectId,
      query_text: queryText,
      query_hash: queryHash,
      query_embedding: embedding ?? null,
      response,
      response_summary: body?.response_summary ?? body?.responseSummary ?? null,
      model: body?.model ?? null,
      agent_version: body?.agent_version ?? body?.agentVersion ?? null,
      template_version: body?.template_version ?? body?.templateVersion ?? null,
      created_at: now,
      updated_at: now,
    })
    .select("id")
    .single();
  if (error) return json({ error: error.message }, 500);
  return json({ ok: true, id: data?.id ?? null });
}

export async function handleGallery(
  req: Request,
  segments: string[],
  url: URL,
  body: any,
) {
  const method = req.method.toUpperCase();
  if (segments[0] !== "gallery") return null;
  if (method === "GET" && segments.length === 1) {
    return handleGetGallery(req, url);
  }
  if (method === "GET" && segments.length === 2) {
    return handleGetGalleryItem(req, segments[1]);
  }
  if (method === "POST" && segments.length === 3 && segments[2] === "vote") {
    return handleVoteGalleryItem(req, segments[1]);
  }
  if (method === "DELETE" && segments.length === 3 && segments[2] === "vote") {
    return handleUnvoteGalleryItem(req, segments[1]);
  }
  if (
    method === "POST" && segments.length === 4 && segments[2] === "cache" &&
    segments[3] === "lookup"
  ) {
    return handleLookupGalleryCache(req, segments[1], body);
  }
  if (method === "POST" && segments.length === 3 && segments[2] === "cache") {
    return handleStoreGalleryCache(req, segments[1], body);
  }
  return null;
}
