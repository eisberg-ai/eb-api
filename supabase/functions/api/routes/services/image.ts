import type { ServiceDefinition } from './text.ts';

export const imageServices: ServiceDefinition[] = [
  { stub: 'nano-banana-pro', name: 'Nano Banana Pro', description: 'Advanced image generation' },
  { stub: 'gpt-image-1', name: 'GPT Image 1', description: 'OpenAI image generation' },
  { stub: 'ideogram-3.0', name: 'Ideogram 3.0', description: 'Ideogram image model' },
];

export function getImageServices(): ServiceDefinition[] {
  return imageServices;
}

export async function proxyImageService(stub: string, req: Request, body: any): Promise<Response> {
  // TODO: implement actual proxy logic for each service
  return new Response(JSON.stringify({ error: 'not implemented' }), { status: 501, headers: { 'Content-Type': 'application/json' } });
}










