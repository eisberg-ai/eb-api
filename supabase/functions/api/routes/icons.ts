import { json } from "../lib/response.ts";
import { getUserOrService } from "../lib/auth.ts";
import { Resvg, initWasm } from "npm:@resvg/resvg-wasm@2.6.2";

// Initialize WASM once
let wasmInitialized = false;

async function ensureWasmInitialized() {
  if (wasmInitialized) return;
  try {
    // Try auto-initialization first
    await initWasm();
  } catch (_e) {
    // Fall back to fetching from unpkg
    const wasmResponse = await fetch("https://unpkg.com/@resvg/resvg-wasm@2.6.2/index_bg.wasm");
    if (!wasmResponse.ok) {
      throw new Error(`Failed to fetch WASM: ${wasmResponse.status}`);
    }
    const wasmBuffer = await wasmResponse.arrayBuffer();
    await initWasm(wasmBuffer);
  }
  wasmInitialized = true;
}

// Color gradients (matching mobile app)
const COLOR_GRADIENTS: Record<string, [string, string]> = {
  cyan: ["#22d3ee", "#06b6d4"],
  teal: ["#00e4a0", "#00c896"],
  indigo: ["#6366f1", "#4f46e5"],
  violet: ["#a855f7", "#9333ea"],
  pink: ["#ec4899", "#db2777"],
};

// Lucide icon SVG paths (stroke-based)
const ICON_PATHS: Record<string, string> = {
  rocket: `<path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/>`,
  star: `<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>`,
  zap: `<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>`,
  heart: `<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/>`,
  globe: `<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>`,
  music: `<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>`,
  camera: `<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/>`,
  game: `<line x1="6" x2="10" y1="12" y2="12"/><line x1="8" x2="8" y1="10" y2="14"/><line x1="15" x2="15.01" y1="13" y2="13"/><line x1="18" x2="18.01" y1="11" y2="11"/><rect width="20" height="12" x="2" y="6" rx="2"/>`,
  sparkles: `<path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/><path d="M5 3v4"/><path d="M19 17v4"/><path d="M3 5h4"/><path d="M17 19h4"/>`,
};

function generateIconSvg(
  iconId: string,
  colorId: string,
  size: number = 512
): string {
  const gradient = COLOR_GRADIENTS[colorId] || COLOR_GRADIENTS.cyan;
  const iconPath = ICON_PATHS[iconId] || ICON_PATHS.sparkles;

  // Icon viewBox is 24x24, we scale it to fit nicely in the center
  const iconSize = size * 0.45;
  const iconOffset = (size - iconSize) / 2;
  const iconScale = iconSize / 24;
  const borderRadius = size * 0.22;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="${gradient[0]}"/>
      <stop offset="100%" stop-color="${gradient[1]}"/>
    </linearGradient>
    <clipPath id="roundedRect">
      <rect x="0" y="0" width="${size}" height="${size}" rx="${borderRadius}" ry="${borderRadius}"/>
    </clipPath>
  </defs>

  <!-- Background with rounded corners -->
  <rect x="0" y="0" width="${size}" height="${size}" rx="${borderRadius}" ry="${borderRadius}" fill="url(#bg)"/>

  <!-- Glossy overlay (top half) -->
  <rect x="0" y="0" width="${size}" height="${size / 2}" rx="${borderRadius}" ry="${borderRadius}" fill="rgba(255,255,255,0.15)" clip-path="url(#roundedRect)"/>

  <!-- Icon -->
  <g transform="translate(${iconOffset}, ${iconOffset}) scale(${iconScale})" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    ${iconPath}
  </g>
</svg>`;
}

async function handlePostGenerateIcon(body: Record<string, unknown>) {
  const icon = body?.icon as string;
  if (!icon || typeof icon !== "string") {
    return json({ error: "icon parameter required (format: iconId:colorId)" }, 400);
  }

  const [iconId, colorId = "cyan"] = icon.split(":");
  if (!ICON_PATHS[iconId]) {
    return json({ error: `unknown icon: ${iconId}. valid: ${Object.keys(ICON_PATHS).join(", ")}` }, 400);
  }
  if (!COLOR_GRADIENTS[colorId]) {
    return json({ error: `unknown color: ${colorId}. valid: ${Object.keys(COLOR_GRADIENTS).join(", ")}` }, 400);
  }

  const size = Math.min(Math.max(Number(body?.size) || 512, 32), 1024);

  try {
    await ensureWasmInitialized();

    const svg = generateIconSvg(iconId, colorId, size);
    const resvg = new Resvg(svg, {
      fitTo: { mode: "width", value: size },
    });
    const rendered = resvg.render();
    const pngBuffer = rendered.asPng();

    return new Response(pngBuffer, {
      status: 200,
      headers: {
        "Content-Type": "image/png",
        "Content-Length": String(pngBuffer.length),
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  } catch (error) {
    console.error("generate icon error:", error);
    return json({ error: "failed to generate icon" }, 500);
  }
}

// GET endpoint for easy testing/embedding
async function handleGetIcon(url: URL) {
  const icon = url.searchParams.get("icon");
  const size = url.searchParams.get("size");

  if (!icon) {
    return json({ error: "icon query param required (format: iconId:colorId)" }, 400);
  }

  return handlePostGenerateIcon({ icon, size: size ? Number(size) : 512 });
}

export async function handleIcons(
  req: Request,
  segments: string[],
  url: URL,
  body: Record<string, unknown>
) {
  const method = req.method.toUpperCase();

  // POST /generate-icon
  if (method === "POST" && segments[0] === "generate-icon") {
    const { user } = await getUserOrService(req);
    if (!user) return json({ error: "unauthorized" }, 401);
    return handlePostGenerateIcon(body);
  }

  // GET /generate-icon?icon=rocket:cyan&size=512
  if (method === "GET" && segments[0] === "generate-icon") {
    const { user } = await getUserOrService(req);
    if (!user) return json({ error: "unauthorized" }, 401);
    return handleGetIcon(url);
  }

  return null;
}
