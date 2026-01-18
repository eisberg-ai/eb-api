import type { ServiceDefinition } from './text.ts';

export const videoServices: ServiceDefinition[] = [
  { stub: 'sora-2', name: 'Sora 2', description: 'Fast video generation model' },
  { stub: 'sora-2-pro', name: 'Sora 2 Pro', description: 'High-quality video generation' },
];

export function getVideoServices(): ServiceDefinition[] {
  return videoServices;
}

export async function proxyVideoService(stub: string, req: Request, body: any): Promise<Response> {
  // TODO: implement actual proxy logic for each service
  return new Response(JSON.stringify({ error: 'not implemented' }), { status: 501, headers: { 'Content-Type': 'application/json' } });
}










