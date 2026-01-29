import { json, serveUserland } from "../_shared/userland.ts";

serveUserland(async (ctx) => {
  const input = ctx.input as { label?: string };
  const label = typeof input?.label === "string" ? input.label.trim() : "";
  if (!label) {
    return json({ error: "label_required" }, 400);
  }

  const { data, error } = await ctx.db
    .from("items")
    .insert({ label })
    .select("id,label,created_at")
    .single();

  if (error) {
    console.error("insertItem error", error);
    return json({ error: "insert_failed" }, 500);
  }

  return { item: data };
});
