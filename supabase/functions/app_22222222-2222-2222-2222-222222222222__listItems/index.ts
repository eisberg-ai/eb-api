import { json, serveUserland } from "../_shared/userland.ts";

serveUserland(async (ctx) => {
  const { data, error } = await ctx.db
    .from("items")
    .select("id,label,created_at")
    .order("created_at", { ascending: true });

  if (error) {
    console.error("listItems error", error);
    return json({ error: "list_failed" }, 500);
  }

  return { items: data ?? [] };
});
