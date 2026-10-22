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

  throw new Error(`Unsupported LLM provider: ${provider}`);
}

// CLI test runner
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const config = await loadConfig();
  const geminiCheck = await validateLLMConfig('gemini');
  const groqCheck = await validateLLMConfig('groq');

  console.log('--- AccessFix Config Check ---');
  console.log('Gemini:', geminiCheck.ready ? `Ready (${geminiCheck.model})` : `Incomplete: missing ${geminiCheck.missing.join(', ')}`);
  console.log('Groq:  ', groqCheck.ready ? `Ready (${groqCheck.model})` : `Incomplete: missing ${groqCheck.missing.join(', ')}`);
  console.log('Port:  ', config.port);
}
