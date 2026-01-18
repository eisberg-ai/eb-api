import type { ServiceDefinition } from './text.ts';

export const dataServices: ServiceDefinition[] = [
  { stub: 'apple-maps', name: 'Apple Maps', description: 'Maps and location services' },
  { stub: 'the-movie-database', name: 'The Movie Database', description: 'Movie and TV data' },
  { stub: 'openweather-api', name: 'OpenWeather API', description: 'Weather data' },
  { stub: 'stock-market-data', name: 'Stock Market Data', description: 'Financial market data' },
  { stub: 'crypto-market-data', name: 'Crypto Market Data', description: 'Cryptocurrency data' },
];

export function getDataServices(): ServiceDefinition[] {
  return dataServices;
}

export async function proxyDataService(stub: string, req: Request, body: any): Promise<Response> {
  // TODO: implement actual proxy logic for each service
  return new Response(JSON.stringify({ error: 'not implemented' }), { status: 501, headers: { 'Content-Type': 'application/json' } });
}










