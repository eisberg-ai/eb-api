import { admin } from "./env.ts";

type SystemMessageInput = {
  id: string;
  projectId: string;
  buildId?: string | null;
  content: string;
  type?: string | null;
};

export async function upsertSystemMessage(input: SystemMessageInput) {
  const { id, projectId, buildId, content, type } = input;
  const { error } = await admin.from("messages").upsert(
    {
      id,
      project_id: projectId,
      build_id: buildId ?? null,
      role: "agent",
      type: type ?? "status",
      content: [{ kind: "text", text: content }],
    },
    { onConflict: "id" },
  );
  return error ?? null;
}
