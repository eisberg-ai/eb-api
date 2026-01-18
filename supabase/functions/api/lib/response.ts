export function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

export function normalizePath(url: URL) {
  const raw = url.pathname.split("/").filter(Boolean);
  if (raw[0] === "functions" && raw[1] === "v1" && raw[2] === "api") return raw.slice(3);
  if (raw[0] === "api") return raw.slice(1);
  return raw;
}

export function historyPatchScript(prefix: string) {
  const json = JSON.stringify(prefix);
  return `(function(){try{var prefix=${json};var path=window.location.pathname;if(path===prefix+"index.html"){path=prefix}if(path.startsWith(prefix)){var rest=path.slice(prefix.length);var next="/"+rest.replace(/^\\//,"");if(next==="//"||next===""){next="/"}var url=next+window.location.search+window.location.hash;if(url===""){url="/"}window.history.replaceState({}, "", url)}}catch(e){}})();`;
}

export function rewriteHtmlForSubpath(html: string, baseHref: string) {
  // absolute paths (/_expo) + base tag = correct resolution for subpaths
  const baseTag = `<base href="${baseHref}">`;
  const inject = `${baseTag}\n    <script>${historyPatchScript(baseHref)}</script>`;
  let out = html;
  if (out.match(/<head[^>]*>/i)) {
    out = out.replace(/<head([^>]*)>/i, `<head$1>\n    ${inject}\n`);
  } else {
    out = `${inject}\n${out}`;
  }
  return out;
}
