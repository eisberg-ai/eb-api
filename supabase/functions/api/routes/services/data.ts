import type { ServiceDefinition } from './text.ts';

export const dataServices: ServiceDefinition[] = [
  { stub: 'apple-maps', name: 'Apple Maps', description: 'Maps and location services', provider: 'apple', model: 'apple-maps', disabled: true },
  { stub: 'tmdb', name: 'The Movie Database', description: 'Movie and TV data', provider: 'tmdb', model: 'tmdb', disabled: true },
  { stub: 'openweather', name: 'OpenWeather', description: 'Weather data', provider: 'openweather', model: 'openweather', disabled: true },
  { stub: 'alpha-vantage-stock', name: 'Alpha Vantage Stock', description: 'Financial market data', provider: 'alpha-vantage', model: 'alpha-vantage-stock', disabled: true },
  { stub: 'alpha-vantage-crypto', name: 'Alpha Vantage Crypto', description: 'Cryptocurrency data', provider: 'alpha-vantage', model: 'alpha-vantage-crypto', disabled: true },
];

export function getDataServices(): ServiceDefinition[] {
  return dataServices;
}

export async function proxyDataService(stub: string, req: Request, body: any): Promise<Response> {
  // TODO: implement actual proxy logic for each service
  return new Response(JSON.stringify({ error: 'not implemented' }), { status: 501, headers: { 'Content-Type': 'application/json' } });
}








