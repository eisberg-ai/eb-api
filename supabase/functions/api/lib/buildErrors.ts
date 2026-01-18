export const BUILD_ERROR_CODES = [
  "insufficient_balance",
  "dependency_install_failed",
  "worker_error",
  "worker_killed",
  "unknown",
] as const;

export type BuildErrorCode = (typeof BUILD_ERROR_CODES)[number];

export type BuildError = {
  code: BuildErrorCode;
  message: string;
};

export function isBuildErrorCode(value: unknown): value is BuildErrorCode {
  return typeof value === "string" && (BUILD_ERROR_CODES as readonly string[]).includes(value);
}

export function parseBuildErrorCode(value: unknown): BuildErrorCode | null {
  return isBuildErrorCode(value) ? value : null;
}
