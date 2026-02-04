import { admin } from "../lib/env.ts";
import { json } from "../lib/response.ts";
import { getUserOrService } from "../lib/auth.ts";

const DEFAULT_LIMIT = 24;
const MAX_LIMIT = 100;

const normalizeQuery = (value: string) =>
  value.trim().toLowerCase().replace(/\s+/g, " ");

const parseListParam = (value: string | null) => {
  if (!value) return [];
  return value
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
};

const clampLimit = (raw: string | null) => {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, parsed));
};

async function hashQuery(query: string): Promise<string> {
  const data = new TextEncoder().encode(query);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function embedText(query: string): Promise<number[] | null> {
  const apiKey = Deno.env.get("OPENAI_API_KEY") ?? Deno.env.get("OPENAI_EMBEDDINGS_API_KEY");
  if (!apiKey) return null;
  const model = Deno.env.get("OPENAI_EMBEDDINGS_MODEL") ?? "text-embedding-3-small";
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

async function handleGetGallery(url: URL) {
  const limit = clampLimit(url.searchParams.get("limit"));
  const offset = Math.max(0, Number(url.searchParams.get("offset") ?? "0") || 0);
  const search = (url.searchParams.get("search") ?? "").trim();
  const tags = parseListParam(url.searchParams.get("tags"));
  const categories = parseListParam(url.searchParams.get("categories"));

  let query = admin
    .from("projects")
    .select("id, name, owner_user_id, updated_at, created_at, is_public, is_gallery, gallery_slug, gallery, latest_build_id, status")
    .eq("is_public", true)
    .neq("status", "draft")
    .neq("status", "archived")
    .order("updated_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (search) {
    query = query.ilike("name", `%${search}%`);
  }

  const { data: projects, error } = await query;
  if (error) return json({ error: error.message }, 500);

  const buildIds = (projects ?? [])
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

  const items = (projects ?? []).map((project: any) => {
    const gallery = normalizeGallery(project.gallery);
    const build = project.latest_build_id ? buildMap.get(project.latest_build_id) : null;
    return {
      id: project.id,
      slug: project.gallery_slug ?? project.id,
      title: project.name ?? "Untitled",
      summary: pickGalleryValue(gallery, "summary", ""),
      categories: pickGalleryValue(gallery, "categories", []),
      tags: pickGalleryValue(gallery, "tags", []),
      icon_url: pickGalleryValue(gallery, "icon_url", pickGalleryValue(gallery, "icon", null)),
      hero_url: pickGalleryValue(gallery, "hero_url", pickGalleryValue(gallery, "hero", null)),
      author: pickGalleryValue(gallery, "author", null),
      updated_at: project.updated_at ?? null,
      created_at: project.created_at ?? null,
      preview_url: build?.artifacts?.web ?? null,
      version_number: build?.version_number ?? null,
    };
  });

  const filteredItems = items.filter((item) => {
    if (tags.length > 0) {
      const itemTags = Array.isArray(item.tags) ? item.tags : [];
      if (!tags.some((tag) => itemTags.includes(tag))) return false;
    }
    if (categories.length > 0) {
      const itemCategories = Array.isArray(item.categories) ? item.categories : [];
      if (!categories.some((category) => itemCategories.includes(category))) return false;
    }
    return true;
  });

  return json({ items: filteredItems });
}

async function handleGetGalleryItem(slugOrId: string) {
  const baseQuery = () =>
    admin
      .from("projects")
      .select("id, name, owner_user_id, updated_at, created_at, is_public, is_gallery, gallery_slug, gallery, latest_build_id, status")
      .eq("is_public", true)
      .eq("is_gallery", true)
      .neq("status", "draft")
      .neq("status", "archived");

  const { data: slugMatch, error: slugError } = await baseQuery()
    .eq("gallery_slug", slugOrId)
    .maybeSingle();
  if (slugError) return json({ error: slugError.message }, 500);
  if (slugMatch) {
    return buildGalleryDetailResponse(slugMatch);
  }

  const { data: idMatch, error: idError } = await baseQuery()
    .eq("id", slugOrId)
    .maybeSingle();
  if (idError) return json({ error: idError.message }, 500);
  if (!idMatch) return json({ error: "not found" }, 404);
  return buildGalleryDetailResponse(idMatch);
}

async function buildGalleryDetailResponse(project: any) {
  let build = null;
  if (project.latest_build_id) {
    const { data: buildRow } = await admin
      .from("builds")
      .select("id, artifacts, version_number")
      .eq("id", project.latest_build_id)
      .maybeSingle();
    build = buildRow;
  }
  const gallery = normalizeGallery(project.gallery);

  return json({
    item: {
      id: project.id,
      slug: project.gallery_slug ?? project.id,
      title: project.name ?? "Untitled",
      summary: pickGalleryValue(gallery, "summary", ""),
      categories: pickGalleryValue(gallery, "categories", []),
      tags: pickGalleryValue(gallery, "tags", []),
      icon_url: pickGalleryValue(gallery, "icon_url", pickGalleryValue(gallery, "icon", null)),
      hero_url: pickGalleryValue(gallery, "hero_url", pickGalleryValue(gallery, "hero", null)),
      author: pickGalleryValue(gallery, "author", null),
      updated_at: project.updated_at ?? null,
      created_at: project.created_at ?? null,
      preview_url: build?.artifacts?.web ?? null,
      version_number: build?.version_number ?? null,
      gallery,
    },
  });
}

async function handleLookupGalleryCache(req: Request, projectId: string, body: any) {
  const queryTextRaw = body?.query ?? body?.prompt ?? "";
  const queryText = typeof queryTextRaw === "string" ? queryTextRaw.trim() : "";
  if (!queryText) return json({ error: "query required" }, 400);
  const normalized = normalizeQuery(queryText);
  const queryHash = await hashQuery(normalized);
  const thresholdRaw = Number(body?.threshold ?? body?.min_score ?? body?.minScore ?? 0.86);
  const threshold = Number.isFinite(thresholdRaw) ? thresholdRaw : 0.86;
  const limit = clampLimit(body?.limit?.toString?.() ?? null);

  const { data: exactMatches, error: exactErr } = await admin
    .from("app_gallery_cache")
    .select("id, project_id, query_text, query_hash, response, response_summary, model, agent_version, template_version, created_at")
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
  const match = Array.isArray(matches) && matches.length > 0 ? matches[0] : null;
  return json({ hit: match });
}

async function handleStoreGalleryCache(req: Request, projectId: string, body: any) {
  const { service } = await getUserOrService(req, { allowServiceKey: true });
  if (!service) return json({ error: "unauthorized" }, 401);
  const queryTextRaw = body?.query ?? body?.prompt ?? "";
  const queryText = typeof queryTextRaw === "string" ? queryTextRaw.trim() : "";
  const response = body?.response ?? null;
  if (!queryText) return json({ error: "query required" }, 400);
  if (!response || typeof response !== "object") return json({ error: "response required" }, 400);

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

export async function handleGallery(req: Request, segments: string[], url: URL, body: any) {
  const method = req.method.toUpperCase();
  if (segments[0] !== "gallery") return null;
  if (method === "GET" && segments.length === 1) {
    return handleGetGallery(url);
  }
  if (method === "GET" && segments.length === 2) {
    return handleGetGalleryItem(segments[1]);
  }
  if (method === "POST" && segments.length === 4 && segments[2] === "cache" && segments[3] === "lookup") {
    return handleLookupGalleryCache(req, segments[1], body);
  }
  if (method === "POST" && segments.length === 3 && segments[2] === "cache") {
    return handleStoreGalleryCache(req, segments[1], body);
  }
  return null;
}
