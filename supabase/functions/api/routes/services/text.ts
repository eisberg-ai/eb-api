export interface ServiceDefinition {
  stub: string;
  name: string;
  description?: string;
  config?: Record<string, any>;
  provider?: string;
  model?: string;
}

interface TextServiceConfig {
  apiKey?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

export const textServices: ServiceDefinition[] = [
  { stub: 'claude-opus-4-5', name: 'Opus 4.5', description: "Anthropic's best model for specialized reasoning tasks", provider: 'anthropic', model: 'claude-opus-4-5-20251101' },
  { stub: 'claude-sonnet-4-5', name: 'Sonnet 4.5', description: 'Best model from Anthropic', provider: 'anthropic', model: 'claude-sonnet-4-5-20250929' },
  { stub: 'gpt-5.2', name: 'GPT-5.2', description: 'The best model from OpenAI', provider: 'openai', model: 'gpt-5.2-chat-latest' },
  { stub: 'gemini-3-pro', name: 'Gemini 3 Pro', description: 'The best model from Google', provider: 'google', model: 'gemini-3-pro-preview' },
];

function getProviderApiKey(provider: string): string | null {
  if (provider === "openai") return Deno.env.get("OPENAI_API_KEY") ?? null;
  if (provider === "google") return Deno.env.get("GOOGLE_API_KEY") ?? null;
  if (provider === "anthropic") return Deno.env.get("ANTHROPIC_API_KEY") ?? null;
  if (provider === "deepseek") return Deno.env.get("DEEPSEEK_API_KEY") ?? null;
  if (provider === "xai") return Deno.env.get("XAI_API_KEY") ?? null;
  return null;
}

async function callOpenAI(messages: any[], config: TextServiceConfig) {
  const apiKey = config.apiKey;
  if (!apiKey) throw new Error('service_api_key_missing');
  const model = config.model || 'gpt-4o';
  const supportsTemperature = !model.startsWith("gpt-5.2");
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      ...(supportsTemperature ? { temperature: config.temperature ?? 0.7 } : {}),
      ...(config.maxTokens ? { max_tokens: config.maxTokens } : {}),
    }),
  });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`openai api error: ${response.status} ${errorText}`);
  }
  return response.json();
}

async function callGoogle(messages: any[], config: TextServiceConfig) {
  const apiKey = config.apiKey;
  if (!apiKey) throw new Error('service_api_key_missing');
  const model = config.model || 'gemini-2.0-flash-exp';
  const contents: any[] = [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    contents.push({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content || '' }],
    });
  }
  const systemInstruction = messages.find(m => m.role === 'system')?.content;
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents,
      ...(systemInstruction ? { systemInstruction: { parts: [{ text: systemInstruction }] } } : {}),
      generationConfig: {
        temperature: config.temperature ?? 0.7,
        ...(config.maxTokens ? { maxOutputTokens: config.maxTokens } : {}),
      },
    }),
  });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`google api error: ${response.status} ${errorText}`);
  }
  const data = await response.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  const usage = data.usageMetadata ? {
    prompt_tokens: data.usageMetadata.promptTokenCount || 0,
    completion_tokens: data.usageMetadata.candidatesTokenCount || 0,
    total_tokens: data.usageMetadata.totalTokenCount || 0,
  } : {};
  return {
    choices: [{ message: { content: text, role: 'assistant' } }],
    model,
    id: data.modelVersion || `gemini-${Date.now()}`,
    usage,
  };
}

async function callAnthropic(messages: any[], config: TextServiceConfig) {
  const apiKey = config.apiKey;
  if (!apiKey) throw new Error('service_api_key_missing');
  const model = config.model || 'claude-3-5-sonnet-20241022';
  const systemMessage = messages.find(m => m.role === 'system');
  const conversationMessages = messages.filter(m => m.role !== 'system');
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      messages: conversationMessages,
      ...(systemMessage ? { system: systemMessage.content } : {}),
      temperature: config.temperature ?? 0.7,
      max_tokens: config.maxTokens ?? 4096,
    }),
  });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`anthropic api error: ${response.status} ${errorText}`);
  }
  const data = await response.json();
  const text = data.content?.[0]?.text || '';
  return {
    choices: [{ message: { content: text, role: 'assistant' } }],
    model: data.model || model,
    id: data.id || `msg-${Date.now()}`,
    usage: data.usage || {},
  };
}

async function callDeepSeek(messages: any[], config: TextServiceConfig) {
  const apiKey = config.apiKey;
  if (!apiKey) throw new Error('service_api_key_missing');
  const model = config.model || 'deepseek-chat';
  const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: config.temperature ?? 0.7,
      ...(config.maxTokens ? { max_tokens: config.maxTokens } : {}),
    }),
  });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`deepseek api error: ${response.status} ${errorText}`);
  }
  return response.json();
}

async function callXAI(messages: any[], config: TextServiceConfig) {
  const apiKey = config.apiKey;
  if (!apiKey) throw new Error('service_api_key_missing');
  const model = config.model || 'grok-beta';
  const response = await fetch('https://api.x.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: config.temperature ?? 0.7,
      ...(config.maxTokens ? { max_tokens: config.maxTokens } : {}),
    }),
  });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`xai api error: ${response.status} ${errorText}`);
  }
  return response.json();
}

export function getTextServices(): ServiceDefinition[] {
  return textServices;
}

const textServiceMap = new Map(textServices.map((service) => [service.stub, service]));

export async function proxyTextService(stub: string, req: Request, body: any): Promise<Response> {
  const serviceInfo = textServiceMap.get(stub);
  if (!serviceInfo) {
    return new Response(JSON.stringify({ error: `unknown service stub: ${stub}` }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  const provider = serviceInfo.provider ?? "unknown";
  const defaultModel = serviceInfo.model ?? serviceInfo.stub;
  const config: TextServiceConfig = {
    apiKey: body.config?.apiKey ?? body.config?.api_key,
    model: body.config?.model || defaultModel,
    temperature: body.temperature ?? body.config?.temperature,
    maxTokens: body.maxTokens ?? body.max_tokens ?? body.config?.maxTokens,
  };
  if (!config.apiKey) {
    config.apiKey = getProviderApiKey(provider) ?? undefined;
  }
  const messages = body.messages || [];
  if (!Array.isArray(messages) || messages.length === 0) {
    return new Response(JSON.stringify({ error: 'messages array required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  if (!config.apiKey) {
    return new Response(JSON.stringify({ error: 'service_key_missing' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  try {
    let result: any;
    if (provider === 'openai') {
      result = await callOpenAI(messages, config);
    } else if (provider === 'google') {
      result = await callGoogle(messages, config);
    } else if (provider === 'anthropic') {
      result = await callAnthropic(messages, config);
    } else if (provider === 'deepseek') {
      result = await callDeepSeek(messages, config);
    } else if (provider === 'xai') {
      result = await callXAI(messages, config);
    } else {
      return new Response(JSON.stringify({ error: `unsupported provider: ${provider}` }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const choice = result.choices?.[0];
    if (!choice) {
      return new Response(JSON.stringify({ error: 'no response from service' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({
      id: result.id || `chatcmpl-${Date.now()}`,
      object: 'chat.completion',
      created: result.created || Math.floor(Date.now() / 1000),
      model: result.model || defaultModel,
      choices: [{
        index: 0,
        message: {
          role: choice.message?.role || 'assistant',
          content: choice.message?.content || '',
        },
        finish_reason: choice.finish_reason || 'stop',
      }],
      usage: result.usage || {},
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
