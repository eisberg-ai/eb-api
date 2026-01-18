import type { ServiceDefinition } from './text.ts';

export const audioServices: ServiceDefinition[] = [
  { stub: 'gpt-4o-transcription', name: 'GPT-4o Transcription', description: 'Audio transcription service' },
  { stub: 'elevenlabs-flash-tts', name: 'ElevenLabs Flash 2.5 TTS', description: 'Fast text-to-speech' },
  { stub: 'elevenlabs-sound-effects', name: 'ElevenLabs Sound Effects', description: 'Sound effect generation' },
  { stub: 'elevenlabs-music', name: 'ElevenLabs Music', description: 'Music generation' },
  { stub: 'elevenlabs-voice-changer', name: 'ElevenLabs Voice Changer', description: 'Voice transformation' },
];

export function getAudioServices(): ServiceDefinition[] {
  return audioServices;
}

export async function proxyAudioService(stub: string, req: Request, body: any): Promise<Response> {
  // TODO: implement actual proxy logic for each service
  return new Response(JSON.stringify({ error: 'not implemented' }), { status: 501, headers: { 'Content-Type': 'application/json' } });
}










