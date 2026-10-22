import 'dotenv/config';
import { fileURLToPath } from 'url';
import process from 'process';

// Reads and returns current environment settings
export async function loadConfig() {
  return {
    geminiApiKey: process.env.GEMINI_API_KEY?.trim() || '',
    geminiModel: process.env.GEMINI_MODEL?.trim() || '',
    groqApiKey: process.env.GROQ_API_KEY?.trim() || '',
    groqModel: process.env.GROQ_MODEL?.trim() || '',
    openrouterApiKey: process.env.OPENROUTER_API_KEY?.trim() || '',
    openrouterModel: process.env.OPENROUTER_MODEL?.trim() || '',
    providerOrder: (process.env.LLM_PROVIDER_ORDER || 'groq,gemini,openrouter')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    port: parseInt(process.env.PORT || '3000', 10),
  };
}

// Checks whether an API key and model name are configured for the specified provider
export async function validateLLMConfig(provider = 'gemini') {
  const config = await loadConfig();

  if (provider === 'gemini') {
    const hasKey = Boolean(config.geminiApiKey);
    const hasModel = Boolean(config.geminiModel);
    return {
      provider: 'gemini',
      ready: hasKey && hasModel,
      hasKey,
      hasModel,
      model: config.geminiModel,
      missing: [!hasKey && 'GEMINI_API_KEY', !hasModel && 'GEMINI_MODEL'].filter(Boolean),
    };
  }

  if (provider === 'groq') {
    const hasKey = Boolean(config.groqApiKey);
    const hasModel = Boolean(config.groqModel);
    return {
      provider: 'groq',
      ready: hasKey && hasModel,
      hasKey,
      hasModel,
      model: config.groqModel,
      missing: [!hasKey && 'GROQ_API_KEY', !hasModel && 'GROQ_MODEL'].filter(Boolean),
    };
  }

  if (provider === 'openrouter') {
    const hasKey = Boolean(config.openrouterApiKey);
    return {
      provider: 'openrouter',
      ready: hasKey,
      hasKey,
      hasModel: Boolean(config.openrouterModel),
      model: config.openrouterModel || 'openai/gpt-4o-mini',
      missing: [!hasKey && 'OPENROUTER_API_KEY'].filter(Boolean),
    };
  }

  throw new Error(`Unsupported LLM provider: ${provider}`);
}

// CLI test runner
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const config = await loadConfig();
  const geminiCheck = await validateLLMConfig('gemini');
  const groqCheck = await validateLLMConfig('groq');
  const openrouterCheck = await validateLLMConfig('openrouter');

  console.log('--- AccessFix Config Check ---');
  console.log('Provider Order:', config.providerOrder.join(', '));
  console.log('Gemini:    ', geminiCheck.ready ? `Ready (${geminiCheck.model})` : `Incomplete: missing ${geminiCheck.missing.join(', ')}`);
  console.log('Groq:      ', groqCheck.ready ? `Ready (${groqCheck.model})` : `Incomplete: missing ${groqCheck.missing.join(', ')}`);
  console.log('OpenRouter:', openrouterCheck.ready ? `Ready (${openrouterCheck.model})` : `Incomplete: missing ${openrouterCheck.missing.join(', ')}`);
  console.log('Port:      ', config.port);
}
