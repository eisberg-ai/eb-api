import { admin } from "./env.ts";
import { applyCreditDelta, getCreditBalance } from "../routes/billing.ts";

// minimum balance required to start a build (pay-as-you-go)
export const MIN_BUILD_BALANCE = 0.10;

/**
 * Check if user has enough credits to start a build.
 */
export async function checkBuildCredits(userId: string): Promise<{ balance: number }> {
  const balance = await getCreditBalance(userId);
  if (balance < MIN_BUILD_BALANCE) {
    throw new Error("insufficient_balance");
  }
  return { balance };
}

/**
 * Spend credits incrementally during build (pay-as-you-go).
 * Returns the new balance. Throws if insufficient.
 */
export async function spendBuildCredits(args: {
  userId: string;
  amount: number;
  buildId: string;
  description?: string;
  metadata?: Record<string, unknown>;
}): Promise<{ balance: number }> {
  const { userId, amount, buildId, description, metadata } = args;
  // check balance first
  const balance = await getCreditBalance(userId);
  if (balance <= 0) {
    throw new Error("insufficient_balance");
  }
  if (balance < amount) {
    // charge remaining credits (floor at 0) then fail
    await applyCreditDelta({
      userId,
      delta: -balance,
      type: "spend",
      description: description || `Build usage (insufficient funds)`,
      metadata: { buildId, requestedUsd: amount, balanceBeforeUsd: balance, ...metadata },
      idempotencyKey: `build-spend-drain-${buildId}-${Date.now()}`,
    });
    throw new Error("insufficient_balance");
  }
  // apply the spend
  const entry = await applyCreditDelta({
    userId,
    delta: -amount,
    type: "spend",
    description: description || `Build usage`,
    metadata: { buildId, ...metadata },
    idempotencyKey: `build-spend-${buildId}-${Date.now()}`,
  });
  return { balance: entry.balance_after };
}

/**
 * Promote a build without charging (charging happens incrementally now).
 */
export async function promoteBuild(
  projectId: string,
  buildId: string,
  versionNumber?: number,
  artifacts?: Record<string, string>
) {
  let vnum = versionNumber;
  if (!vnum) {
    const { data } = await admin
      .from("builds")
      .select("version_number")
      .eq("project_id", projectId)
      .eq("is_promoted", true)
      .order("version_number", { ascending: false })
      .limit(1);
    vnum = data && data.length ? (data[0].version_number || 0) + 1 : 1;
  }
  await admin.from("builds").update({ is_promoted: true, version_number: vnum, artifacts }).eq("id", buildId);
  await admin.from("projects").update({ current_version_number: vnum, latest_build_id: buildId }).eq("id", projectId);
}
