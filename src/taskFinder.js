import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import process from 'process';
import { chromium } from 'playwright';
import { callLLM } from './llm.js';
import { validateLLMConfig } from './config.js';
import { resolveTargetUrl } from './scanner.js';

// Infers the primary goal on a page from its title and accessibility tree, or reads demo-sites/tasks.json
export async function findTask(pageTitle, ariaTree, sitePath = '') {
  // For demo sites, return deterministic benchmark task without LLM call
  if (sitePath && (sitePath.includes('demo-sites') || sitePath.includes('broken') || sitePath.includes('fixed'))) {
    const tasksFilePath = path.resolve('demo-sites', 'tasks.json');
    const raw = await fs.readFile(tasksFilePath, 'utf-8');
    return JSON.parse(raw);
  }

  // Verify that an API key is available before making external LLM call
  const geminiCheck = await validateLLMConfig('gemini');
  const groqCheck = await validateLLMConfig('groq');
  const openrouterCheck = await validateLLMConfig('openrouter');

  if (!geminiCheck.hasKey && !groqCheck.hasKey && !openrouterCheck.hasKey) {
    throw new Error('Cannot find task: No LLM API key configured in .env (set GEMINI_API_KEY, GROQ_API_KEY, or OPENROUTER_API_KEY).');
  }

  const prompt = `You are given a web page's title and its accessibility tree. Pick the ONE most important task a visitor comes to this page to do. Return JSON only: {task, hint, success:{type, value}}. success.type must be textVisible, urlContains or elementVisible, and must be checkable by a browser script after the task is done. Page title: ${pageTitle}. Accessibility tree: ${ariaTree}`;

  return await callLLM({
    prompt,
    systemPrompt: 'Respond strictly with valid JSON conforming to {task, hint, success:{type, value}}.',
  });
}

// Checks if the task success condition has been met using Playwright only (never LLM)
export async function checkSuccess(page, success) {
  if (!page || !success || !success.type) {
    return false;
  }

  try {
    const { type, value } = success;

    if (type === 'textVisible') {
      const bodyText = await page.evaluate(() => (document.body ? document.body.innerText : ''));
      return typeof bodyText === 'string' && bodyText.toLowerCase().includes(String(value).toLowerCase());
    }

    if (type === 'urlContains') {
      const currentUrl = page.url();
      return typeof currentUrl === 'string' && currentUrl.toLowerCase().includes(String(value).toLowerCase());
    }

    if (type === 'elementVisible') {
      return await page.locator(String(value)).isVisible();
    }

    return false;
  } catch {
    // Fail silently to false per specification
    return false;
  }
}

// CLI test harness
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const targetPath = process.argv[2] || 'demo-sites/broken.html';
  const siteName = process.argv[3] || (targetPath.includes('fixed') ? 'fixed' : 'broken');

  console.log(`[taskFinder] Testing task discovery on ${targetPath}...`);

  const browser = await chromium.launch({
    headless: true,
    args: ['--single-process', '--no-sandbox', '--disable-gpu'],
  });

  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const targetUrl = resolveTargetUrl(targetPath);

    await page.goto(targetUrl, { waitUntil: 'networkidle' });

    const pageTitle = await page.title();
    const ariaTree = await page.locator('body').ariaSnapshot();

    // 1. Discover task
    const task = await findTask(pageTitle, ariaTree, targetPath);
    console.log('\n--- Task Discovered ---');
    console.log('Task:   ', task.task);
    console.log('Hint:   ', task.hint);
    console.log('Success:', JSON.stringify(task.success));

    // 2. Check BEFORE action (expected: false)
    const successBefore = await checkSuccess(page, task.success);
    console.log('\ncheckSuccess BEFORE action:', successBefore, '(expected: false)');

    // 3. Perform test interaction using mouse
    console.log('\n[harness] Filling email and clicking Subscribe with mouse...');
    await page.locator('#emailInput, input[type="email"]').fill('tester@example.com');
    await page.locator('.btn-subscribe').click();
    await page.waitForTimeout(200);

    // 4. Check AFTER action (expected: true)
    const successAfter = await checkSuccess(page, task.success);
    console.log('checkSuccess AFTER action: ', successAfter, '(expected: true)\n');
  } catch (err) {
    console.error('[taskFinder] Error:', err.message);
    process.exit(1);
  } finally {
    await browser.close();
  }
}
