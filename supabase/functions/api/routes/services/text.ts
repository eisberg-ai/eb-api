export interface ServiceDefinition {
  stub: string;
  name: string;
  description?: string;
  config?: Record<string, any>;
}

interface TextServiceConfig {
  apiKey?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

const STUB_TO_MODEL: Record<string, { provider: string; model: string }> = {
  'claude-sonnet-4-5': { provider: 'anthropic', model: 'claude-3-5-sonnet-20241022' },
  'claude-opus-4-5': { provider: 'anthropic', model: 'claude-3-opus-20240229' },
  'gpt-5.2': { provider: 'openai', model: 'gpt-4o-2024-11-20' },
  'gemini-3-pro': { provider: 'google', model: 'gemini-2.0-flash-exp' },
};

export const textServices: ServiceDefinition[] = [
  { stub: 'claude-sonnet-4-5', name: 'Sonnet 4.5', description: 'Best model from Anthropic' },
  { stub: 'claude-opus-4-5', name: 'Opus 4.5', description: "Anthropic's best model for specialized reasoning tasks" },
  { stub: 'gpt-5.2', name: 'GPT-5.2', description: 'The best model from OpenAI' },
  { stub: 'gemini-3-pro', name: 'Gemini 3 Pro', description: 'The best model from Google' },
];

async function callOpenAI(messages: any[], config: TextServiceConfig) {
  const apiKey = config.apiKey || Deno.env.get('OPENAI_API_KEY');
  if (!apiKey) throw new Error('OPENAI_API_KEY not configured');
  const model = config.model || 'gpt-4o';
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
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
    throw new Error(`openai api error: ${response.status} ${errorText}`);
  }
  return response.json();
}

async function callGoogle(messages: any[], config: TextServiceConfig) {
  const apiKey = config.apiKey || Deno.env.get('GOOGLE_API_KEY');
  if (!apiKey) throw new Error('GOOGLE_API_KEY not configured');
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
  const apiKey = config.apiKey || Deno.env.get('ANTHROPIC_API_KEY');
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured');
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
  const apiKey = config.apiKey || Deno.env.get('DEEPSEEK_API_KEY');
  if (!apiKey) throw new Error('DEEPSEEK_API_KEY not configured');
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
  const apiKey = config.apiKey || Deno.env.get('XAI_API_KEY');
  if (!apiKey) throw new Error('XAI_API_KEY not configured');
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

export async function proxyTextService(stub: string, req: Request, body: any): Promise<Response> {
  const serviceInfo = STUB_TO_MODEL[stub];
  if (!serviceInfo) {
    return new Response(JSON.stringify({ error: `unknown service stub: ${stub}` }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  const { provider, model: defaultModel } = serviceInfo;
  const config: TextServiceConfig = {
    apiKey: body.config?.apiKey,
    model: body.config?.model || defaultModel,
    temperature: body.temperature ?? body.config?.temperature,
    maxTokens: body.maxTokens ?? body.max_tokens ?? body.config?.maxTokens,
  };
  const messages = body.messages || [];
  if (!Array.isArray(messages) || messages.length === 0) {
    return new Response(JSON.stringify({ error: 'messages array required' }), {
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









