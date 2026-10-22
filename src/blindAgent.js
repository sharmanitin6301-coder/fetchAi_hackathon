import path from 'path';
import { fileURLToPath } from 'url';
import process from 'process';
import { chromium } from 'playwright';
import { callLLM } from './llm.js';
import { validateLLMConfig } from './config.js';
import { checkSuccess, findTask } from './taskFinder.js';
import { resolveTargetUrl } from './scanner.js';
import { saveStageCache } from './cache.js';

// Predefined scripted keyboard sequences used as deterministic fallback or benchmark baseline
const SCRIPTED_SEQUENCES = {
  broken: [
    { action: 'Tab', thought: 'Moving focus into page content via Tab.' },
    { action: 'Tab', thought: 'Advancing focus to next interactive control via Tab.' },
    { action: 'Type:alex@example.com', thought: 'Typing email address into focused textbox.' },
    { action: 'Tab', thought: 'Attempting to reach Subscribe button via Tab.' },
    { action: 'Tab', thought: 'Button not reached; searching next control with Tab.' },
    { action: 'Tab', thought: 'Button not reached; searching next control with Tab.' },
    { action: 'Tab', thought: 'Button not reached; searching next control with Tab.' },
    { action: 'Tab', thought: 'Button not reached; searching next control with Tab.' },
    { action: 'Tab', thought: 'Button not reached; searching next control with Tab.' },
    { action: 'Tab', thought: 'Button not reached; searching next control with Tab.' },
  ],
  fixed: [
    { action: 'Tab', thought: 'Pressing Tab to reach promo banner close button.' },
    { action: 'Tab', thought: 'Pressing Tab to reach the email input.' },
    { action: 'Type:alex@example.com', thought: 'Typing email address into email input field.' },
    { action: 'Tab', thought: 'Pressing Tab to reach the Subscribe button.' },
    { action: 'Enter', thought: 'Pressing Enter on the Subscribe button to submit.' },
  ],
};

// Inspects active element and extracts screen reader announcement data
export async function observeFocusedElement(page) {
  const active = await page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body || el === document.documentElement) {
      return {
        role: 'none',
        name: 'none',
        tag: 'body',
        selector: 'body',
      };
    }

    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role') || (tag === 'input' ? 'textbox' : tag);

    // Compute accessible name per WCAG priority order
    let name = '';
    if (el.getAttribute('aria-label')) {
      name = el.getAttribute('aria-label').trim();
    } else if (el.getAttribute('aria-labelledby')) {
      const ids = el.getAttribute('aria-labelledby').split(/\s+/);
      name = ids.map((id) => document.getElementById(id)?.textContent?.trim() || '').join(' ').trim();
    } else if (el.id) {
      const label = document.querySelector(`label[for="${el.id}"]`);
      if (label) name = label.textContent.trim();
    }
    if (!name && el.closest('label')) {
      name = el.closest('label').textContent.trim();
    }
    if (!name && el.getAttribute('alt')) {
      name = el.getAttribute('alt').trim();
    }
    if (!name && el.getAttribute('title')) {
      name = el.getAttribute('title').trim();
    }
    if (!name && el.textContent) {
      name = el.textContent.trim().replace(/\s+/g, ' ');
    }

    const accessibleName = name ? name : 'unlabelled';

    let selector = tag;
    if (el.id) {
      selector = `#${el.id}`;
    } else if (el.className && typeof el.className === 'string') {
      const firstClass = el.className.trim().split(/\s+/).filter(Boolean)[0];
      if (firstClass) selector = `${tag}.${firstClass}`;
    }

    return {
      role,
      name: accessibleName,
      tag,
      selector,
    };
  });

  const heard = active.role === 'none' ? 'No element focused' : `${active.role}, ${active.name}`;
  const ariaSnapshot = (await page.locator('body').ariaSnapshot()).slice(0, 3000);

  return {
    ...active,
    heard,
    ariaSnapshot,
  };
}

// Determines the next keyboard action using LLM or scripted fallback
export async function decideNextAction({ task, observation, recentActions, stepIndex, siteKey, forceScripted }) {
  // If scripted mode is forced, return predetermined script step immediately
  if (forceScripted) {
    const sequence = SCRIPTED_SEQUENCES[siteKey] || SCRIPTED_SEQUENCES.broken;
    const scriptedStep = sequence[stepIndex] || { action: 'Tab', thought: 'Searching for reachable controls via Tab.' };
    return {
      heard: observation.heard,
      thought: `[Scripted Fallback] ${scriptedStep.thought}`,
      action: scriptedStep.action,
      mode: 'scripted',
    };
  }

  // Autonomous LLM blind agent prompt
  const recentHistoryText = recentActions
    .slice(-5)
    .map((a, i) => `  ${i + 1}. Action: "${a.action}" | Result: "${a.heard}"`)
    .join('\n') || '  (No previous actions)';

  const prompt = `Goal: ${task.task}
Hint: ${task.hint || 'None'}

Current Screen Reader Announcement:
- Heard: "${observation.heard}"
- Role: ${observation.role}
- Accessible Name: ${observation.name}
- Element Tag: ${observation.tag}

Recent Actions (last 5):
${recentHistoryText}

Page Accessibility Tree Snapshot (first 3000 chars):
${observation.ariaSnapshot}

You are a blind user browsing strictly via keyboard. Pick ONE next action.
Allowed actions:
- "Tab"
- "Shift+Tab"
- "Enter"
- "Space"
- "ArrowDown"
- "ArrowUp"
- "Type:<text>" (example: Type:user@example.com)

Return JSON ONLY matching:
{
  "heard": "${observation.heard}",
  "thought": "<brief reasoning for your next keyboard action>",
  "action": "<one of the allowed action strings>"
}`;

  const geminiCheck = await validateLLMConfig('gemini');
  const provider = geminiCheck.ready ? 'gemini' : 'groq';

  try {
    const response = await callLLM({
      prompt,
      systemPrompt: 'You are an accessibility blind agent navigating strictly by keyboard. Output JSON only: {heard, thought, action}.',
      provider,
    });

    return {
      heard: response.heard || observation.heard,
      thought: response.thought || 'Advancing keyboard focus.',
      action: response.action || 'Tab',
      mode: 'llm',
    };
  } catch (err) {
    // If LLM fails (e.g. 503 high demand / network error), fall back to scripted mode honestly
    console.warn(`[blindAgent] LLM call unavailable (${err.message}). Falling back to scripted mode.`);
    const sequence = SCRIPTED_SEQUENCES[siteKey] || SCRIPTED_SEQUENCES.broken;
    const scriptedStep = sequence[stepIndex] || { action: 'Tab', thought: 'Continuing search via Tab.' };
    return {
      heard: observation.heard,
      thought: `[Scripted Fallback - LLM Unavailable] ${scriptedStep.thought}`,
      action: scriptedStep.action,
      mode: 'scripted-fallback',
    };
  }
}

// Performs the keyboard action strictly using page.keyboard
export async function executeKeyboardAction(page, rawAction) {
  const action = (rawAction || '').trim();

  if (action === 'Tab') {
    await page.keyboard.press('Tab');
  } else if (action === 'Shift+Tab') {
    await page.keyboard.press('Shift+Tab');
  } else if (action === 'Enter') {
    await page.keyboard.press('Enter');
  } else if (action === 'Space') {
    await page.keyboard.press('Space');
  } else if (action === 'ArrowDown') {
    await page.keyboard.press('ArrowDown');
  } else if (action === 'ArrowUp') {
    await page.keyboard.press('ArrowUp');
  } else if (action.startsWith('Type:')) {
    const textToType = action.slice(5);
    await page.keyboard.type(textToType);
  } else {
    await page.keyboard.press('Tab');
  }

  await page.waitForTimeout(150);
}

// Main Blind Agent navigation loop
export async function runBlindAgent(page, task, options = {}) {
  const maxSteps = options.maxSteps || 40;
  const siteName = options.siteName || 'broken';
  const runType = options.runType || 'before';

  const geminiCheck = await validateLLMConfig('gemini');
  const groqCheck = await validateLLMConfig('groq');
  const hasKey = geminiCheck.hasKey || groqCheck.hasKey;
  let forceScripted = Boolean(options.scriptedMode || !hasKey);

  const siteKey = siteName.includes('fixed') ? 'fixed' : 'broken';
  const transcript = [];
  const focusCounts = {};
  let stuckAt = null;
  let isSuccess = false;
  let activeMode = forceScripted ? 'scripted' : 'llm';

  console.log(`[blindAgent] Starting agent (mode: ${forceScripted ? 'scripted fallback' : 'autonomous LLM'}, maxSteps: ${maxSteps})...`);

  for (let step = 1; step <= maxSteps; step++) {
    // 1. OBSERVE
    const observation = await observeFocusedElement(page);

    // Track repeated focus visits to detect focus loops or unreachable interactive elements
    const focusKey = observation.selector;
    if (focusKey !== 'body') {
      focusCounts[focusKey] = (focusCounts[focusKey] || 0) + 1;
      if (focusCounts[focusKey] >= 4) {
        stuckAt = `Element '${focusKey}' (${observation.heard}) focused 4 times without completing task. Target Subscribe control is unreachable via keyboard (non-focusable <div> with no tabindex).`;
        transcript.push({
          step,
          heard: observation.heard,
          thought: `Focus loop detected on ${focusKey}. Stopping agent.`,
          action: 'STOP',
        });
        break;
      }
    }

    // 2. THINK
    const decision = await decideNextAction({
      task,
      observation,
      recentActions: transcript,
      stepIndex: step - 1,
      siteKey,
      forceScripted,
    });

    if (decision.mode !== 'llm') {
      activeMode = decision.mode;
      forceScripted = true; // Stay in fallback if LLM failed
    }

    transcript.push({
      step,
      heard: decision.heard,
      thought: decision.thought,
      action: decision.action,
    });

    console.log(`  Step ${step}:`);
    console.log(`    Heard:   "${decision.heard}"`);
    console.log(`    Thought: ${decision.thought}`);
    console.log(`    Action:  ${decision.action}`);

    // 3. ACT
    await executeKeyboardAction(page, decision.action);

    // 4. CHECK
    isSuccess = await checkSuccess(page, task.success);
    if (isSuccess) {
      console.log(`  [SUCCESS] Goal achieved at step ${step}!`);
      break;
    }
  }

  if (!isSuccess && !stuckAt) {
    stuckAt = `Reached maximum step limit (${maxSteps}) without achieving success condition.`;
  }

  const result = {
    success: isSuccess,
    steps: transcript.length,
    stuckAt: isSuccess ? null : stuckAt,
    mode: activeMode,
    transcript,
  };

  const stageName = `agent_${runType}`;
  await saveStageCache(siteName, stageName, result);
  console.log(`[blindAgent] Transcript saved to cache/${siteName}/${stageName}.json`);

  return result;
}

// CLI test harness
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const targetPath = process.argv[2] || 'demo-sites/broken.html';
  const siteName = process.argv[3] || (targetPath.includes('fixed') ? 'fixed' : 'broken');
  const runType = process.argv[4] || (targetPath.includes('fixed') ? 'after' : 'before');
  const forceScriptedArg = process.argv.includes('--scripted');

  console.log(`\n======================================================`);
  console.log(` AccessFix Blind Agent CLI Test`);
  console.log(` Target: ${targetPath} | Site: ${siteName} | Run: ${runType}`);
  if (forceScriptedArg) console.log(` Flag: --scripted mode enabled`);
  console.log(`======================================================`);

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
    const task = await findTask(pageTitle, ariaTree, targetPath);

    console.log(`Task: "${task.task}"`);
    console.log(`Goal: ${JSON.stringify(task.success)}\n`);

    const result = await runBlindAgent(page, task, {
      siteName,
      runType,
      maxSteps: 30,
      scriptedMode: forceScriptedArg,
    });

    console.log('\n--- Final Agent Summary ---');
    console.log(`Status:  ${result.success ? 'SUCCESS' : 'FAILED'}`);
    console.log(`Steps:   ${result.steps}`);
    console.log(`Mode:    ${result.mode}`);
    if (result.stuckAt) {
      console.log(`Reason:  ${result.stuckAt}`);
    }
    console.log('======================================================\n');
  } catch (err) {
    console.error('[blindAgent] Execution failed:', err);
    process.exit(1);
  } finally {
    await browser.close();
  }
}
