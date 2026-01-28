import { admin, awsClient, r2PreviewBucket, r2Endpoint, r2PreviewPublicBase } from "../lib/env.ts";
import { rewriteHtmlForSubpath } from "../lib/response.ts";
import { startVm } from "../lib/vm.ts";

const PREVIEW_CSP = [
  "default-src * data: blob: 'unsafe-inline' 'unsafe-eval'",
  "style-src * data: blob: 'unsafe-inline'",
  "script-src * data: blob: 'unsafe-inline' 'unsafe-eval'",
  "img-src * data: blob:",
  "font-src * data: blob:",
  "connect-src * data: blob:",
  "frame-src * data: blob:",
].join("; ");

function buildPreviewShell(previewSrc: string) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Eisberg Preview</title>
    <style>
      :root { color-scheme: light dark; }
      body { margin: 0; background: #0a0a0a; color: #fff; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
      .frame { position: relative; width: 390px; height: 844px; border-radius: 48px; background: #0d0d0f; padding: 12px; box-shadow: 0 30px 80px rgba(0,0,0,0.55); border: 1px solid rgba(255,255,255,0.06); }
      .frame::before { content: ""; position: absolute; top: 10px; left: 50%; transform: translateX(-50%); width: 110px; height: 20px; border-radius: 999px; background: #050505; opacity: 0.9; }
      .screen { width: 100%; height: 100%; border-radius: 36px; overflow: hidden; background: #000; }
      iframe { width: 100%; height: 100%; border: 0; display: block; }
      body.is-mobile { background: #000; }
      body.is-mobile .frame { width: 100%; height: 100vh; border-radius: 0; padding: 0; box-shadow: none; border: none; }
      body.is-mobile .frame::before { display: none; }
      body.is-mobile .screen { border-radius: 0; }
    </style>
  </head>
  <body>
    <div class="frame">
      <div class="screen">
        <iframe src="${previewSrc}" title="App preview" allow="clipboard-read; clipboard-write; fullscreen"></iframe>
      </div>
    </div>
    <script>
      (function() {
        var update = function() {
          var isMobile = window.innerWidth <= 768 || window.innerHeight <= 700;
          document.body.classList.toggle('is-mobile', isMobile);
        };
        window.addEventListener('resize', update);
        update();
      })();
    </script>
  </body>
</html>`;
}

function buildPreviewHeaders(
  contentType?: string,
  withCsp = false,
  debug?: { branch?: string; restPath?: string; upstreamType?: string },
) {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Origin": "*",
    "X-Preview-Handler": "preview-v3",
  };
  if (debug?.branch) headers["X-Preview-Branch"] = debug.branch;
  if (debug?.restPath) headers["X-Preview-Rest-Path"] = debug.restPath;
  if (debug?.upstreamType) headers["X-Preview-Upstream-Type"] = debug.upstreamType;
  if (contentType) headers["X-Preview-Content-Type"] = contentType;
  if (contentType) headers["Content-Type"] = contentType;
  if (withCsp) headers["Content-Security-Policy"] = PREVIEW_CSP;
  return headers;
}

function baseHrefForPath(pathname: string) {
  let baseHref = pathname.replace(/\/+$/, "");
  if (baseHref.endsWith("/index.html") || baseHref.endsWith(".html")) {
    baseHref = baseHref.substring(0, baseHref.lastIndexOf("/") + 1);
  } else {
    baseHref = `${baseHref}/`;
  }
  return baseHref;
}

function getRequestBaseHref(req: Request, url: URL) {
  // Try to recover the original path (Supabase strips /functions/v1 locally)
  const headerCandidates = [
    "x-forwarded-uri",
    "x-original-uri",
    "x-envoy-original-path",
    "x-forwarded-path",
  ];
  for (const header of headerCandidates) {
    const val = req.headers.get(header);
    if (!val) continue;
    try {
      const parsed = new URL(val, `${url.protocol}//${url.host}`);
      return baseHrefForPath(parsed.pathname);
    } catch {
      if (val.startsWith("/")) return baseHrefForPath(val);
    }
  }
  let pathname = url.pathname;
  // Local Supabase functions omit /functions/v1; add it back so asset URLs stay under the function prefix
  if (!pathname.startsWith("/functions/v1/") && pathname.startsWith("/api/")) {
    pathname = `/functions/v1${pathname}`;
  }
  return baseHrefForPath(pathname);
}

function getOriginalPathname(req: Request, url: URL) {
  // Try to recover the original path (Supabase strips /functions/v1 locally)
  const headerCandidates = [
    "x-forwarded-uri",
    "x-original-uri",
    "x-envoy-original-path",
    "x-forwarded-path",
  ];
  for (const header of headerCandidates) {
    const val = req.headers.get(header);
    if (!val) continue;
    try {
      const parsed = new URL(val, `${url.protocol}//${url.host}`);
      return parsed.pathname;
    } catch {
      if (val.startsWith("/")) return val;
    }
  }
  let pathname = url.pathname;
  // Local Supabase functions omit /functions/v1; add it back so asset URLs stay under the function prefix
  if (!pathname.startsWith("/functions/v1/") && pathname.startsWith("/api/")) {
    pathname = `/functions/v1${pathname}`;
  }
  return pathname;
}

function getPreviewRootBaseHref(req: Request, url: URL, projectId: string, version: string) {
  const pathname = getOriginalPathname(req, url);
  const marker = `/preview/${projectId}/${version}`;
  const idx = pathname.indexOf(marker);
  let root = idx >= 0 ? pathname.slice(0, idx + marker.length) : pathname;
  if (!root.endsWith("/")) root = `${root}/`;
  // Local Supabase sometimes provides /api/... paths; ensure browser-facing base includes /functions/v1
  if (!root.startsWith("/functions/v1/") && root.startsWith("/api/")) {
    root = `/functions/v1${root}`;
  }
  return root;
}

function parseBuildPreviewSegments(segments: string[]) {
  if (segments.length < 2) return null;
  if (segments[1]?.startsWith("build-")) {
    return { buildId: segments[1], restSegments: segments.slice(2) };
  }
  if (segments[1] === "build" && segments[2]) {
    return { buildId: segments[2], restSegments: segments.slice(3) };
  }
  return null;
}

async function handleBuildPreview(req: Request, segments: string[], url: URL) {
  const parsed = parseBuildPreviewSegments(segments);
  if (!parsed) return null;
  const { buildId, restSegments } = parsed;
  const restPath = restSegments.length === 0 ? "index.html" : restSegments.join("/");
  const isHtmlPath = restPath.toLowerCase().endsWith(".html");
  const { data: build, error } = await admin
    .from("builds")
    .select("id, artifacts")
    .eq("id", buildId)
    .maybeSingle();
  if (error || !build) {
    return new Response("build not found", {
      status: 404,
      headers: buildPreviewHeaders("text/plain", false, { branch: "vm-not-found", restPath }),
    });
  }
  const webUrl = (build.artifacts as any)?.web as string | undefined;
  if (!webUrl) {
    return new Response("preview not available", {
      status: 404,
      headers: buildPreviewHeaders("text/plain", false, { branch: "vm-missing-preview", restPath }),
    });
  }
  let upstream: URL;
  try {
    const base = new URL(webUrl);
    const basePath = base.pathname.replace(/\/+$/, "") + "/";
    upstream = new URL(basePath + restPath, `${base.protocol}//${base.host}`);
  } catch (_e) {
    return new Response("invalid preview url", {
      status: 400,
      headers: buildPreviewHeaders("text/plain", false, { branch: "vm-invalid-url", restPath }),
    });
  }
  const upstreamResp = await fetch(upstream.toString(), { redirect: "follow" });
  const contentType = upstreamResp.headers.get("Content-Type") || "";
  if (!upstreamResp.ok) {
    return new Response(`preview fetch failed (${upstreamResp.status})`, {
      status: upstreamResp.status,
      headers: buildPreviewHeaders("text/plain", false, {
        branch: "vm-upstream-error",
        restPath,
        upstreamType: contentType || undefined,
      }),
    });
  }
  if (contentType.includes("text/html") || isHtmlPath) {
    const html = await upstreamResp.text();
    const baseHref = getRequestBaseHref(req, url);
    const rewritten = rewriteHtmlForSubpath(html, baseHref);
    return new Response(rewritten, {
      status: 200,
      headers: buildPreviewHeaders("text/html; charset=utf-8", true, {
        branch: "vm-html",
        restPath,
        upstreamType: contentType || undefined,
      }),
    });
  }
  const body = await upstreamResp.arrayBuffer();
  return new Response(body, {
    status: 200,
    headers: buildPreviewHeaders(contentType || undefined, false, {
      branch: "vm-binary",
      restPath,
      upstreamType: contentType || undefined,
    }),
  });
}

async function handleGetPreview(req: Request, segments: string[], url: URL) {
  const projectId = segments[1];
  const version = segments[2];
  try {
    await startVm({ projectId, mode: "serving" });
  } catch (err) {
    console.error("[preview] failed to start vm", { projectId, error: err });
  }
  const restSegments = segments.slice(3);
  const restPath = restSegments.length === 0 ? "index.html" : restSegments.join("/");
  const isHtmlPath = restPath.toLowerCase().endsWith(".html");
  const isJsPath = restPath.toLowerCase().endsWith(".js") || restPath.toLowerCase().endsWith(".mjs");
  const isIndexHtml = restPath === "index.html";
  const wantsRaw = url.searchParams.get("raw") === "1";
  const key = `${projectId}/${version}/${restPath}`.replace(/\/+/g, "/").replace(/^\//, "");
  const baseHref = getRequestBaseHref(req, url);
  const previewRootBaseHref = getPreviewRootBaseHref(req, url, projectId, version);
  const candidates: string[] = [];
  if (r2PreviewPublicBase) {
    candidates.push(`${r2PreviewPublicBase}/${key}`);
  }
  const endpointHost = (() => {
    try {
      return new URL(r2Endpoint).host;
    } catch {
      return "";
    }
  })();
  if (endpointHost.startsWith("pub-")) {
    candidates.push(`${r2Endpoint}/${key}`);
  } else {
    candidates.push(`${r2Endpoint}/${r2PreviewBucket}/${key}`);
  }
  try {
    const urlObj = new URL(r2Endpoint);
    const host = urlObj.host;
    if (host.includes("r2.cloudflarestorage.com")) {
      const vh = `${urlObj.protocol}//${r2PreviewBucket}.${host}/${key}`;
      candidates.push(vh);
    }
  } catch (_e) {
    // ignore bad endpoint
  }
  const errors: string[] = [];
  for (const urlCandidate of candidates) {
    try {
      const resp = await fetch(urlCandidate, { redirect: "follow" });
      if (!resp.ok) {
        errors.push(`${urlCandidate} => ${resp.status}`);
        continue;
      }
      const contentType = resp.headers.get("Content-Type") || "";
      // check if response is XML (bucket listing) and skip it
      if (contentType.includes("application/xml") || contentType.includes("text/xml")) {
        const text = await resp.text();
        if (text.includes("ListAllMyBucketsResult") || text.includes("ListBucketResult")) {
          errors.push(`${urlCandidate} => XML bucket listing (not object)`);
          continue;
        }
      }
      const isHtml = contentType.includes("text/html") || isHtmlPath;
      const isJs = contentType.includes("javascript") || isJsPath;
      if (isHtml) {
        const html = await resp.text();
        if (isIndexHtml && !wantsRaw) {
          const previewSrc = `${previewRootBaseHref}index.html?raw=1`;
          const shell = buildPreviewShell(previewSrc);
          return new Response(shell, {
            status: 200,
            headers: buildPreviewHeaders("text/html; charset=utf-8", true, {
              branch: "fetch-html-shell",
              restPath,
              upstreamType: contentType || undefined,
            }),
          });
        }
        const rewritten = rewriteHtmlForSubpath(html, baseHref);
        return new Response(rewritten, {
          status: 200,
          headers: buildPreviewHeaders("text/html; charset=utf-8", true, {
            branch: "fetch-html",
            restPath,
            upstreamType: contentType || undefined,
          }),
        });
      }
      if (isJs) {
        const js = await resp.text();
        const rewritten = js
          .replaceAll("\"/assets/", `"${previewRootBaseHref}assets/`)
          .replaceAll("'/assets/", `'${previewRootBaseHref}assets/`)
          .replaceAll("url(/assets/", `url(${previewRootBaseHref}assets/`);
        return new Response(rewritten, {
          status: 200,
          headers: buildPreviewHeaders(contentType || "text/javascript", false, {
            branch: "fetch-js",
            restPath,
            upstreamType: contentType || undefined,
          }),
        });
      }
      const buf = new Uint8Array(await resp.arrayBuffer());
      const type = contentType || "application/octet-stream";
      return new Response(buf, {
        status: 200,
        headers: buildPreviewHeaders(type, false, {
          branch: "fetch-binary",
          restPath,
          upstreamType: contentType || undefined,
        }),
      });
    } catch (err) {
      errors.push(`${urlCandidate} => ${(err as Error).message}`);
    }
  }
  if (awsClient) {
    try {
      const objectUrl = new URL(r2Endpoint);
      const path = `/${r2PreviewBucket}/${key}`.replace(/\/+/g, "/");
      console.log("preview awsClient fetch", { origin: objectUrl.origin, path, key, bucket: r2PreviewBucket });
      const res = await awsClient.fetch(objectUrl.origin, {
        method: "GET",
        path,
      });
      if (res.ok) {
        const contentType = res.headers.get("Content-Type") || "";
        const isXml = contentType.includes("application/xml") || contentType.includes("text/xml");
        const isHtml = contentType.includes("text/html") || isHtmlPath;
        const isJs = contentType.includes("javascript") || isJsPath;
        let xmlListing = false;
        if (isHtml || isXml) {
          const bodyText = await res.text();
          if (isXml) {
            if (bodyText.includes("ListAllMyBucketsResult") || bodyText.includes("ListBucketResult") || bodyText.includes("<Error>")) {
              errors.push(`awsClient => XML bucket listing or error`);
              console.error("preview awsClient XML response", { path, contentType, preview: bodyText.substring(0, 200) });
              xmlListing = true;
            } else {
              const headers = buildPreviewHeaders(res.headers.get("Content-Type") || undefined, true, {
                branch: "aws-xml",
                restPath,
                upstreamType: contentType || undefined,
              });
              return new Response(bodyText, { status: res.status, headers });
            }
          }
          if (isHtml && !xmlListing) {
            if (isIndexHtml && !wantsRaw) {
              const previewSrc = `${previewRootBaseHref}index.html?raw=1`;
              const shell = buildPreviewShell(previewSrc);
              return new Response(shell, {
                status: 200,
                headers: buildPreviewHeaders("text/html; charset=utf-8", true, {
                  branch: "aws-html-shell",
                  restPath,
                  upstreamType: contentType || undefined,
                }),
              });
            }
            const rewritten = rewriteHtmlForSubpath(bodyText, baseHref);
            return new Response(rewritten, {
              status: 200,
              headers: buildPreviewHeaders("text/html; charset=utf-8", true, {
                branch: "aws-html",
                restPath,
                upstreamType: contentType || undefined,
              }),
            });
          }
        }
        if (isJs) {
          const jsText = await res.text();
          const rewritten = jsText
            .replaceAll("\"/assets/", `"${previewRootBaseHref}assets/`)
            .replaceAll("'/assets/", `'${previewRootBaseHref}assets/`)
            .replaceAll("url(/assets/", `url(${previewRootBaseHref}assets/`);
          const headers = buildPreviewHeaders(res.headers.get("Content-Type") || undefined, false, {
            branch: "aws-js",
            restPath,
            upstreamType: contentType || undefined,
          });
          return new Response(rewritten, { status: res.status, headers });
        }
        // binary content, read as arrayBuffer
        const body = await res.arrayBuffer();
        const headers = buildPreviewHeaders(res.headers.get("Content-Type") || undefined, false, {
          branch: "aws-binary",
          restPath,
          upstreamType: contentType || undefined,
        });
        return new Response(body, { status: res.status, headers });
      }
      errors.push(`awsClient => ${res.status}`);
    } catch (err) {
      errors.push(`awsClient => ${(err as Error).message}`);
    }
  }
  console.error("preview fetch failed", { key, projectId: segments[1], version: segments[2], restPath, errors });
  return new Response(`Preview not found: ${key}\n\nTried:\n${errors.join('\n')}`, {
    status: 404,
    headers: buildPreviewHeaders("text/plain", false, { branch: "not-found", restPath }),
  });
}

export async function handlePreview(req: Request, segments: string[], url: URL, _body: any) {
  if (segments[0] !== "preview" && segments[0] !== "preview-remote") return null;
  const buildPreview = await handleBuildPreview(req, segments, url);
  if (buildPreview) return buildPreview;
  // GET /preview/{projectId}/{version}/...
  return handleGetPreview(req, segments, url);
}
