import { decodeBase64, encodeBase64 } from "https://deno.land/std@0.224.0/encoding/base64.ts";

type EncryptedPayload = {
  iv: string;
  data: string;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function deriveKey(secret: string): Promise<CryptoKey> {
  const secretBytes = encoder.encode(secret);
  const hash = await crypto.subtle.digest("SHA-256", secretBytes);
  return crypto.subtle.importKey(
    "raw",
    hash,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function encryptJson(secret: string, payload: unknown): Promise<string> {
  if (!secret) {
    throw new Error("publish_secret_not_configured");
  }
  const key = await deriveKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = encoder.encode(JSON.stringify(payload ?? {}));
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext),
  );
  const encoded: EncryptedPayload = {
    iv: encodeBase64(iv),
    data: encodeBase64(cipher),
  };
  return JSON.stringify(encoded);
}

export async function decryptJson<T>(secret: string, payload: string): Promise<T> {
  if (!secret) {
    throw new Error("publish_secret_not_configured");
  }
  const parsed = JSON.parse(payload) as EncryptedPayload;
  if (!parsed?.iv || !parsed?.data) {
    throw new Error("invalid_encrypted_payload");
  }
  const key = await deriveKey(secret);
  const iv = decodeBase64(parsed.iv);
  const data = decodeBase64(parsed.data);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, data);
  return JSON.parse(decoder.decode(plaintext)) as T;
}
