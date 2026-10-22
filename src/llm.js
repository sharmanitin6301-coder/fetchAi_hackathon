import { fileURLToPath } from 'url';
import process from 'process';
import { loadConfig, validateLLMConfig } from './config.js';

// Strips markdown code fences (```json ... ```) and extracts JSON payload
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

// Calls either Gemini or Groq, enforces JSON output, and retries once on parse error
export async function callLLM({
  prompt,
  systemPrompt = 'Respond strictly with valid JSON. Do not include markdown code fences or conversational text.',
  provider = 'gemini',
  retries = 1,
}) {
  const config = await loadConfig();
  const validation = await validateLLMConfig(provider);

  if (!validation.ready) {
    const missing = validation.missing.join(', ');
    throw new Error(`LLM provider "${provider}" is not configured. Missing: ${missing}`);
  }

  let rawText = '';

  // Branch by provider using official SDKs
  if (provider === 'gemini') {
    const { GoogleGenAI } = await import('@google/genai');
    const ai = new GoogleGenAI({ apiKey: config.geminiApiKey });
    const response = await ai.models.generateContent({
      model: config.geminiModel,
      contents: prompt,
      config: {
        systemInstruction: systemPrompt,
        responseMimeType: 'application/json',
      },
    });
    rawText = response.text || '';
  } else if (provider === 'groq') {
    const { Groq } = await import('groq-sdk');
    const groq = new Groq({ apiKey: config.groqApiKey });
    const completion = await groq.chat.completions.create({
      model: config.groqModel,
      messages: [
        ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
        { role: 'user', content: prompt },
      ],
      response_format: { type: 'json_object' },
    });
    rawText = completion.choices[0]?.message?.content || '';
  } else {
    throw new Error(`Unsupported provider: ${provider}`);
  }

  // Validate and parse JSON output, retry once if malformed
  try {
    return parseLLMJSON(rawText);
  } catch (err) {
    if (retries > 0) {
      const repairPrompt = `The following output failed to parse as JSON (${err.message}). Fix and return ONLY valid JSON:\n\n${rawText}`;
      return callLLM({
        prompt: repairPrompt,
        systemPrompt: 'You are a JSON repair tool. Output strictly valid JSON without explanations.',
        provider,
        retries: retries - 1,
      });
    }
    throw new Error(`Failed to parse LLM response as JSON: ${err.message}. Raw output: ${rawText}`);
  }
}

// CLI test runner
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const geminiCheck = await validateLLMConfig('gemini');
  const groqCheck = await validateLLMConfig('groq');
  const hasKey = geminiCheck.hasKey || groqCheck.hasKey;

  if (!hasKey) {
    console.log('[llm] No API key is set in .env (GEMINI_API_KEY and GROQ_API_KEY are empty).');
    console.log('[llm] Skipping live LLM call. Set GEMINI_API_KEY or GROQ_API_KEY in .env when ready.');
    process.exit(0);
  }

  const activeProvider = geminiCheck.ready ? 'gemini' : 'groq';
  console.log(`[llm] Running live test call using ${activeProvider}...`);
  try {
    const result = await callLLM({
      prompt: 'Respond with a JSON object: {"status": "operational", "provider": "' + activeProvider + '"}',
      provider: activeProvider,
    });
    console.log('[llm] Test call successful:', result);
  } catch (err) {
    console.error('[llm] Live test call failed:', err.message);
    process.exit(1);
  }
}
