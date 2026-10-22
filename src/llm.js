import 'dotenv/config';
import { fileURLToPath } from 'url';
import process from 'process';
import { loadConfig } from './config.js';

// Strips markdown code fences (```json ... ```) and extracts outermost JSON structure
export function cleanJSONString(text) {
  if (typeof text !== 'string') return '';
  let cleaned = text.trim();

  // Strip code fences if present at boundaries
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }

  // Find outermost JSON structure (object or array) to handle any surrounding text
  const firstBrace = cleaned.indexOf('{');
  const firstBracket = cleaned.indexOf('[');
  const start =
    firstBrace !== -1 && firstBracket !== -1
      ? Math.min(firstBrace, firstBracket)
      : firstBrace !== -1
      ? firstBrace
      : firstBracket;

  const lastBrace = cleaned.lastIndexOf('}');
  const lastBracket = cleaned.lastIndexOf(']');
  const end = Math.max(lastBrace, lastBracket);

  if (start !== -1 && end !== -1 && end > start) {
    cleaned = cleaned.slice(start, end + 1);
  }

  return cleaned.trim();
}

// Parses string into JSON after cleaning markdown wrapping
export function parseLLMJSON(raw) {
  const cleaned = cleanJSONString(raw);
  return JSON.parse(cleaned);
}

// Exhaustion tracking: remembers failed providers for 10 minutes
const EXHAUSTION_TTL_MS = 10 * 60 * 1000; // 10 minutes
const exhaustedUntil = new Map(); // providerName -> timestamp

// Checks whether a provider is currently marked as exhausted
export function isProviderExhausted(provider) {
  const until = exhaustedUntil.get(provider.toLowerCase());
  if (!until) return false;
  if (Date.now() >= until) {
    exhaustedUntil.delete(provider.toLowerCase());
    return false;
  }
  return true;
}

// Marks a provider as exhausted for 10 minutes
export function markProviderExhausted(provider, ttlMs = EXHAUSTION_TTL_MS) {
  const p = provider.toLowerCase();
  const until = Date.now() + ttlMs;
  exhaustedUntil.set(p, until);
  const minutes = Math.round(ttlMs / 60000);
  console.warn(`[llm] ${provider} marked as exhausted for ${minutes} minutes (until ${new Date(until).toLocaleTimeString()}).`);
}

// Resets exhaustion map
export function clearExhaustedProviders() {
  exhaustedUntil.clear();
}

// Returns currently exhausted providers and seconds remaining
export function getExhaustedProviders() {
  const result = {};
  for (const [p, exp] of exhaustedUntil.entries()) {
    if (Date.now() < exp) {
      result[p] = Math.ceil((exp - Date.now()) / 1000);
    } else {
      exhaustedUntil.delete(p);
    }
  }
  return result;
}

// Calls Gemini using official @google/genai SDK (no retry delay on error)
async function callGemini({ prompt, systemPrompt, temperature, config }) {
  const { GoogleGenAI } = await import('@google/genai');
  const apiKey = config.geminiApiKey || process.env.GEMINI_API_KEY?.trim();
  const model = config.geminiModel || process.env.GEMINI_MODEL?.trim() || 'gemini-2.5-flash';

  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not configured in .env');
  }

  const ai = new GoogleGenAI({ apiKey });
  const response = await ai.models.generateContent({
    model,
    contents: prompt,
    config: {
      ...(systemPrompt ? { systemInstruction: systemPrompt } : {}),
      ...(temperature !== undefined ? { temperature } : {}),
      responseMimeType: 'application/json',
    },
  });

  return response.text || '';
}

// Calls Groq using official groq-sdk package (no retry delay on error)
async function callGroq({ prompt, systemPrompt, temperature, config }) {
  const { Groq } = await import('groq-sdk');
  const apiKey = config.groqApiKey || process.env.GROQ_API_KEY?.trim();
  const model = config.groqModel || process.env.GROQ_MODEL?.trim() || 'llama-3.3-70b-versatile';

  if (!apiKey) {
    throw new Error('GROQ_API_KEY is not configured in .env');
  }

  const groq = new Groq({ apiKey });
  const messages = [];
  if (systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt });
  }
  messages.push({ role: 'user', content: prompt });

  const completion = await groq.chat.completions.create({
    model,
    messages,
    ...(temperature !== undefined ? { temperature } : {}),
    response_format: { type: 'json_object' },
  });

  return completion.choices[0]?.message?.content || '';
}

// Calls OpenRouter via standard HTTP fetch (no retry delay on error)
async function callOpenRouter({ prompt, systemPrompt, temperature, config }) {
  const apiKey = config.openrouterApiKey || process.env.OPENROUTER_API_KEY?.trim();
  const model = config.openrouterModel || process.env.OPENROUTER_MODEL?.trim() || 'openai/gpt-4o-mini';

  if (!apiKey) {
    throw new Error('OPENROUTER_API_KEY is not configured in .env');
  }

  const messages = [];
  if (systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt });
  }
  messages.push({ role: 'user', content: prompt });

  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'HTTP-Referer': 'https://github.com/accessfix',
      'X-Title': 'AccessFix',
    },
    body: JSON.stringify({
      model,
      messages,
      ...(temperature !== undefined ? { temperature } : {}),
      response_format: { type: 'json_object' },
    }),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    const err = new Error(`OpenRouter HTTP ${res.status}: ${errBody}`);
    err.status = res.status;
    throw err;
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

// Checks if provider has credentials configured in environment
function isProviderConfigured(provider, config) {
  const p = provider.toLowerCase();
  if (p === 'groq') {
    return Boolean(config.groqApiKey || process.env.GROQ_API_KEY?.trim());
  }
  if (p === 'gemini') {
    return Boolean(config.geminiApiKey || process.env.GEMINI_API_KEY?.trim());
  }
  if (p === 'openrouter') {
    return Boolean(config.openrouterApiKey || process.env.OPENROUTER_API_KEY?.trim());
  }
  return false;
}

// Main LLM query interface with configurable provider order and instant exhaustion-based fallback
export async function ask(promptOrOptions, maybeSystemPrompt) {
  let prompt = '';
  let systemPrompt = 'Respond strictly with valid JSON. Do not include markdown code fences or conversational text.';
  let temperature;
  let retries = 1;
  let preferredProvider = null;

  if (typeof promptOrOptions === 'string') {
    prompt = promptOrOptions;
    if (typeof maybeSystemPrompt === 'string') {
      systemPrompt = maybeSystemPrompt;
    }
  } else if (promptOrOptions && typeof promptOrOptions === 'object') {
    prompt = promptOrOptions.prompt || '';
    if (promptOrOptions.systemPrompt) systemPrompt = promptOrOptions.systemPrompt;
    if (promptOrOptions.temperature !== undefined) temperature = promptOrOptions.temperature;
    if (promptOrOptions.retries !== undefined) retries = promptOrOptions.retries;
    if (promptOrOptions.provider) preferredProvider = promptOrOptions.provider.toLowerCase();
  }

  const config = await loadConfig();

  // Configurable provider order via LLM_PROVIDER_ORDER in .env (default: groq,gemini,openrouter)
  const orderString = process.env.LLM_PROVIDER_ORDER?.trim() || config.providerOrder?.join(',') || 'groq,gemini,openrouter';
  let providerOrder = orderString
    .split(',')
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);

  // If caller explicitly passed a preferred provider, try it first if it's configured
  if (preferredProvider && !providerOrder.includes(preferredProvider)) {
    providerOrder.unshift(preferredProvider);
  } else if (preferredProvider && providerOrder[0] !== preferredProvider) {
    providerOrder = [preferredProvider, ...providerOrder.filter((p) => p !== preferredProvider)];
  }

  // Filter for providers that actually have API credentials configured
  const configuredProviders = providerOrder.filter((p) => isProviderConfigured(p, config));

  if (configuredProviders.length === 0) {
    throw new Error(
      `No LLM providers configured. Provider order is [${providerOrder.join(', ')}], but missing API keys in .env (GROQ_API_KEY, GEMINI_API_KEY, or OPENROUTER_API_KEY).`
    );
  }

  // Filter out any providers that are currently marked exhausted
  let candidateProviders = configuredProviders.filter((p) => !isProviderExhausted(p));

  // If ALL configured providers are marked exhausted, reset exhaustion to avoid permanent deadlock
  if (candidateProviders.length === 0) {
    console.warn('[llm] All configured providers were marked exhausted; resetting 10-minute cooldown to retry.');
    clearExhaustedProviders();
    candidateProviders = configuredProviders;
  }

  let rawText = '';
  let respondingProvider = '';
  const errors = [];

  // Try each candidate provider in order; on ANY error immediately mark exhausted for 10m and switch
  for (const provider of candidateProviders) {
    try {
      if (provider === 'groq') {
        rawText = await callGroq({ prompt, systemPrompt, temperature, config });
      } else if (provider === 'gemini') {
        rawText = await callGemini({ prompt, systemPrompt, temperature, config });
      } else if (provider === 'openrouter') {
        rawText = await callOpenRouter({ prompt, systemPrompt, temperature, config });
      } else {
        console.warn(`[llm] Unknown provider "${provider}". Skipping.`);
        continue;
      }

      respondingProvider = provider;
      break; // Successfully answered!
    } catch (err) {
      // Mark provider as exhausted for 10 minutes so we do not waste calls on it
      markProviderExhausted(provider);
      const errMsg = err.message || String(err);
      errors.push(`${provider}: ${errMsg}`);
      console.warn(`[llm] ${provider} failed (${errMsg}). Immediately switching to next provider...`);
    }
  }

  if (!respondingProvider) {
    throw new Error(`All LLM providers failed:\n${errors.map((e) => `  • ${e}`).join('\n')}`);
  }

  // Log which provider answered every call
  console.log(`[llm] answered by ${respondingProvider}`);

  // Validate and parse JSON output, retry once if malformed
  try {
    return parseLLMJSON(rawText);
  } catch (err) {
    if (retries > 0) {
      const repairPrompt = `The following output failed to parse as JSON (${err.message}). Fix and return ONLY valid JSON:\n\n${rawText}`;
      return ask({
        prompt: repairPrompt,
        systemPrompt: 'You are a JSON repair tool. Output strictly valid JSON without explanations.',
        retries: retries - 1,
      });
    }
    // Return wrapped text if model returned plain string
    if (typeof rawText === 'string' && rawText.trim()) {
      return { response: rawText.trim() };
    }
    throw new Error(`Failed to parse LLM response as JSON: ${err.message}. Raw output: ${rawText}`);
  }
}

// Backwards compatibility alias
export const callLLM = ask;

// CLI test runner
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const config = await loadConfig();
  const orderString = process.env.LLM_PROVIDER_ORDER || config.providerOrder?.join(',') || 'groq,gemini,openrouter';
  console.log(`[llm] Running CLI test with provider order: [${orderString}]`);

  const exhausted = getExhaustedProviders();
  if (Object.keys(exhausted).length > 0) {
    console.log('[llm] Currently exhausted providers:', exhausted);
  }

  const rawArg = process.argv[2] || 'say hi';
  const prompt = rawArg.includes('{') || rawArg.toLowerCase().includes('json')
    ? rawArg
    : `${rawArg}\n\nRespond with a valid JSON object, e.g. {"reply": "..."}.`;

  try {
    const result = await ask(prompt);
    console.log('[llm] Result:', JSON.stringify(result, null, 2));
  } catch (err) {
    console.error('[llm] Execution failed:', err.message);
    process.exit(1);
  }
}
