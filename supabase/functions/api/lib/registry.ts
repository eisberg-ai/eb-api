import type { ServiceDefinition } from "../routes/services/text.ts";
import { getTextServices } from "../routes/services/text.ts";
import { getVideoServices } from "../routes/services/video.ts";
import { getAudioServices } from "../routes/services/audio.ts";
import { getImageServices } from "../routes/services/image.ts";
import { getDataServices } from "../routes/services/data.ts";

export interface ModelDefinition {
  id: string;
  name: string;
  provider: string;
  description: string;
  icon?: string;
  isPro?: boolean;
}

export const models: ModelDefinition[] = [
  {
    id: 'claude-sonnet-4-5',
    name: 'Sonnet 4.5',
    provider: 'Anthropic',
    description: 'Best model from Anthropic',
    icon: 'Brain',
  },
  {
    id: 'claude-opus-4-5',
    name: 'Opus 4.5',
    provider: 'Anthropic',
    description: "Anthropic's best model for specialized reasoning tasks",
    icon: 'Brain',
    isPro: true
  },
  {
    id: 'gpt-5.2',
    name: 'GPT-5.2',
    provider: 'OpenAI',
    description: 'The best model from OpenAI',
    icon: 'Bot',
    isPro: false
  },
  {
    id: 'gemini-3-pro',
    name: 'Gemini 3 Pro',
    provider: 'Google',
    description: 'The best model from Google',
    icon: 'Zap',
    isPro: false
  },
];

export function getServicesRegistry(): Record<string, ServiceDefinition[]> {
  return {
    text: getTextServices(),
    video: getVideoServices(),
    audio: getAudioServices(),
    image: getImageServices(),
    data: getDataServices(),
  };
}

export function getModelsRegistry(): ModelDefinition[] {
  return models;
}






