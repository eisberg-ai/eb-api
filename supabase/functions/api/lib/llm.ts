export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LLMOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  apiKey?: string;
}

export interface LLMResponse {
  content: string;
  role: string;
}

async function makeRequest(apiKey: string, messages: LLMMessage[], options: LLMOptions) {
  const model = options.model || 'deepseek-chat';
  const temperature = options.temperature ?? 0.7;
  const maxTokens = options.maxTokens;
  const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      temperature,
      ...(maxTokens ? { max_tokens: maxTokens } : {}),
    }),
  });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`deepseek api error: ${response.status} ${errorText}`);
  }
  return response.json();
}

function parseResponse(data: any): LLMResponse {
  const choice = data.choices?.[0];
  if (!choice) {
    throw new Error('no response from llm');
  }
  return {
    content: choice.message?.content?.trim() || '',
    role: choice.message?.role || 'assistant',
  };
}

/**
 * Calls the DeepSeek LLM API with the given messages and options.
 */
export async function callLLM(
  messages: LLMMessage[],
  options: LLMOptions = {}
): Promise<LLMResponse> {
  const apiKey = options.apiKey || Deno.env.get('DEEPSEEK_API_KEY');
  if (!apiKey) {
    throw new Error('DEEPSEEK_API_KEY not configured');
  }
  const data = await makeRequest(apiKey, messages, options);
  return parseResponse(data);
}











