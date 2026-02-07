import {
  storageClient,
  gcsEndpoint,
  gcsMediaBucket,
  gcsMediaPublicBase,
  r2Client,
  r2Endpoint,
  r2MediaBucket,
  r2MediaPublicBase,
} from "./env.ts";

type UploadOk = { ok: true; provider: "gcs" | "r2" };
type UploadFail = { ok: false; error: string };
type UploadResult = UploadOk | UploadFail;

type DownloadOk = { response: Response; provider: "gcs" | "r2" };

/**
 * Upload an object. Tries GCS first, falls back to R2.
 */
export async function uploadObject(
  objectKey: string,
  body: ArrayBuffer,
  contentType: string,
): Promise<UploadResult> {
  if (storageClient) {
    try {
      const url = `${new URL(gcsEndpoint).origin}/${gcsMediaBucket}/${objectKey}`;
      const res = await storageClient.fetch(url, {
        method: "PUT",
        headers: { "Content-Type": contentType },
        body,
      });
      if (res.ok) return { ok: true, provider: "gcs" };
      const text = await res.text();
      console.warn(`[storage] GCS upload failed (${res.status}): ${text}`);
    } catch (err) {
      console.warn("[storage] GCS upload error:", (err as Error).message);
    }
  }

  if (r2Client && r2Endpoint && r2MediaBucket) {
    try {
      const url = `${new URL(r2Endpoint).origin}/${r2MediaBucket}/${objectKey}`;
      const res = await r2Client.fetch(url, {
        method: "PUT",
        headers: { "Content-Type": contentType },
        body,
      });
      if (res.ok) return { ok: true, provider: "r2" };
      const text = await res.text();
      return { ok: false, error: `R2 upload failed: ${res.status} ${text}` };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  return { ok: false, error: "no storage provider configured" };
}

/**
 * Download an object. Tries GCS first, falls back to R2.
 */
export async function downloadObject(
  objectKey: string,
): Promise<DownloadOk | null> {
  if (storageClient) {
    try {
      const origin = new URL(gcsEndpoint).origin;
      const res = await storageClient.fetch(origin, {
        method: "GET",
        path: `/${gcsMediaBucket}/${objectKey}`,
      });
      if (res.ok) return { response: res, provider: "gcs" };
      console.warn(`[storage] GCS download failed (${res.status})`);
    } catch (err) {
      console.warn("[storage] GCS download error:", (err as Error).message);
    }
  }

  if (r2Client && r2Endpoint && r2MediaBucket) {
    try {
      const origin = new URL(r2Endpoint).origin;
      const res = await r2Client.fetch(origin, {
        method: "GET",
        path: `/${r2MediaBucket}/${objectKey}`,
      });
      if (res.ok) return { response: res, provider: "r2" };
    } catch (err) {
      console.error("[storage] R2 download error:", (err as Error).message);
    }
  }

  return null;
}

/**
 * Get the public URL for a stored object.
 */
export function getObjectUrl(objectKey: string, provider: "gcs" | "r2" = "gcs"): string {
  if (provider === "r2" && r2MediaPublicBase) {
    return `${r2MediaPublicBase}/${objectKey}`;
  }
  if (gcsMediaPublicBase) {
    return `${gcsMediaPublicBase}/${objectKey}`;
  }
  return `${gcsEndpoint}/${gcsMediaBucket}/${objectKey}`;
}
