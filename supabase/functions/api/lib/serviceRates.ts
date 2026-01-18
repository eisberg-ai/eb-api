// service rate mapping: service stub -> cost in dollars per request
export const SERVICE_RATES: Record<string, number> = {
  // text generation
  'gpt-5.2': 0.02,
  'gpt-5.1': 0.01,
  'gpt-5': 0.01,
  'gpt-5-mini': 0.003,
  'gpt-5-nano': 0.001,
  'gpt-5.1-streaming': 0.01,
  'gemini-3-pro': 0.002,
  'grok-4-fast': 0.001,
  'grok-4-fast-reasoning': 0.002,
  'gpt-4.1': 0.03,
  'gpt-4o': 0.01,
  // image generation & editing
  'nano-banana-pro': 0.06,
  'gpt-image-1': 0.10,
  'ideogram-3.0': 0.12,
  // video generation
  'sora-2': 0.25,
  'sora-2-pro': 0.75,
  // audio
  'gpt-4o-transcription': 0.005,
  'elevenlabs-flash-2.5-tts': 0.05,
  'elevenlabs-sound-effects': 0.05,
  'elevenlabs-music': 0.75,
  'elevenlabs-voice-changer': 0.05,
  // data apis
  'apple-maps': 0.0,
  'tmdb': 0.0001,
  'openweather': 0.0015,
  'alpha-vantage-stock': 0.0001,
  'alpha-vantage-crypto': 0.0001,
};

export function getServiceRate(stub: string): number {
  return SERVICE_RATES[stub] ?? 0.0;
}











