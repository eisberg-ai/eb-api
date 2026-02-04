import type { ServiceDefinition } from './text.ts';

export const audioServices: ServiceDefinition[] = [
  { stub: 'gpt-4o-transcription', name: 'GPT-4o Transcription', description: 'Audio transcription service', provider: 'openai', model: 'gpt-4o-transcription', disabled: true },
  { stub: 'elevenlabs-flash-2.5-tts', name: 'ElevenLabs Flash 2.5 TTS', description: 'Fast text-to-speech', provider: 'elevenlabs', model: 'elevenlabs-flash-2.5-tts', disabled: true },
  { stub: 'elevenlabs-sound-effects', name: 'ElevenLabs Sound Effects', description: 'Sound effect generation', provider: 'elevenlabs', model: 'elevenlabs-sound-effects', disabled: true },
  { stub: 'elevenlabs-music', name: 'ElevenLabs Music', description: 'Music generation', provider: 'elevenlabs', model: 'elevenlabs-music', disabled: true },
  { stub: 'elevenlabs-voice-changer', name: 'ElevenLabs Voice Changer', description: 'Voice transformation', provider: 'elevenlabs', model: 'elevenlabs-voice-changer', disabled: true },
];

export function getAudioServices(): ServiceDefinition[] {
  return audioServices;
}

export async function proxyAudioService(stub: string, req: Request, body: any): Promise<Response> {
  // TODO: implement actual proxy logic for each service
  return new Response(JSON.stringify({ error: 'not implemented' }), { status: 501, headers: { 'Content-Type': 'application/json' } });
}








