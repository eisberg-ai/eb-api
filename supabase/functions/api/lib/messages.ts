import { admin } from "./env.ts";

type SystemMessageInput = {
  id: string;
  projectId: string;
  buildId?: string | null;
  content: string;
  metadata?: Record<string, unknown> | null;
};

export async function upsertSystemMessage(input: SystemMessageInput) {
  const { id, projectId, buildId, content, metadata } = input;
  const { error } = await admin.from("messages").upsert(
    {
      id,
      project_id: projectId,
      build_id: buildId ?? null,
      type: "system",
      content,
      metadata: metadata ?? null,
    },
    { onConflict: "id" },
  );
  return error ?? null;
}
