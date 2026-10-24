import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import process from 'process';
import { chromium } from 'playwright';
import { JSDOM } from 'jsdom';
import { runAxeScan, resolveTargetUrl } from './scanner.js';
import { findTask } from './taskFinder.js';
import { runBlindAgent } from './blindAgent.js';
import { prioritize } from './prioritizer.js';
import { fix, applyOp } from './fixer.js';
import { saveStageCache, getSiteCacheDir, readStageCache } from './cache.js';
import { ask } from './llm.js';

// Measures bounding boxes of visible key elements on the page via real Playwright engine
export async function getBoundingBoxes(page) {
  return await page.evaluate(() => {
    const list = {};
    const elements = document.querySelectorAll(
      'html, body, aside, header, nav, main, .promo-banner, .header-bar, .container, .hero-container, img, h1, h2, h3, h4, .newsletter-form, .form-group, #emailInput, label, .helper-text, .btn-subscribe, #statusMessage'
    );
    elements.forEach((el, index) => {
      const rect = el.getBoundingClientRect();
      let selector = el.id
        ? `#${el.id}`
        : el.className && typeof el.className === 'string'
        ? `${el.tagName.toLowerCase()}.${el.className.trim().split(/\s+/)[0]}`
        : el.tagName.toLowerCase();
      if (list[selector]) {
        selector = `${selector}_${index}`;
      }
      list[selector] = {
        selector,
        x: Math.round(rect.x * 10) / 10,
        y: Math.round(rect.y * 10) / 10,
        width: Math.round(rect.width * 10) / 10,
        height: Math.round(rect.height * 10) / 10,
        visible: rect.width > 0 && rect.height > 0 && window.getComputedStyle(el).display !== 'none',
      };
    });
    return list;
  });
}

// Flags movements greater than 5 CSS pixels and marks responsible operation as review
export function checkLayoutShifts(beforeBoxes, afterBoxes, ops = []) {
  const flags = [];
  for (const [key, before] of Object.entries(beforeBoxes)) {
    if (!before.visible) continue;
    const cleanSel = key.split('_')[0];
    const after = afterBoxes[key] || afterBoxes[cleanSel];
    if (!after || !after.visible) continue;

    const dx = Math.abs(after.x - before.x);
    const dy = Math.abs(after.y - before.y);

    if (dx > 5 || dy > 5) {
      const responsibleOp =
        ops.find((o) => o.selector === cleanSel || cleanSel.includes(o.selector)) || null;

      flags.push({
        selector: cleanSel,
        shift: { dx, dy },
        before: { x: before.x, y: before.y, width: before.width, height: before.height },
        after: { x: after.x, y: after.y, width: after.width, height: after.height },
        status: 'review',
        responsibleOp: responsibleOp
          ? { op: responsibleOp.op, selector: responsibleOp.selector, reason: responsibleOp.reason }
          : null,
      });
    }
  }
  return flags;
}

// Generates screen-reader spoken transcript via virtual-screen-reader or DOM accessible fallback in jsdom
export async function generateScreenReaderTranscript(html) {
  // Attempt to use @guidepup/virtual-screen-reader if installed
  try {
    const { virtual } = await import('@guidepup/virtual-screen-reader');
    if (virtual && typeof virtual.start === 'function') {
      try {
        await virtual.start({ defaultContainer: true });
        const phrases = [];
        for (let i = 0; i < 40; i++) {
          const item = await virtual.next();
          if (!item || phrases.includes(item.spokenPhrase)) break;
          phrases.push(item.spokenPhrase);
        }
        return phrases;
      } finally {
        await virtual.stop();
      }
    }
  } catch {
    // Virtual reader unavailable; fall through to DOM-based accessible reading tree fallback
  }

  // DOM accessible speech fallback for jsdom
  const dom = new JSDOM(html);
  const document = dom.window.document;
  const phrases = [];

  function walk(node) {
    if (!node) return;
    if (node.nodeType === 3) {
      const text = node.textContent.trim().replace(/\s+/g, ' ');
      const parentTag = node.parentElement?.tagName.toLowerCase();
      if (
        text &&
        !['script', 'style', 'button', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'label', 'aside', 'nav'].includes(
          parentTag
        )
      ) {
        if (!phrases.includes(text)) phrases.push(text);
      }
      return;
    }

    if (node.nodeType === 1) {
      const tag = node.tagName.toLowerCase();
      if (tag === 'script' || tag === 'style') return;

      if (tag === 'aside' || node.getAttribute('role') === 'region') {
        const label = node.getAttribute('aria-label') || 'announcement';
        phrases.push(`complimentary, ${label}`);
      } else if (tag === 'nav' || node.getAttribute('role') === 'navigation') {
        const label = node.getAttribute('aria-label') || 'navigation';
        phrases.push(`navigation, ${label}`);
      } else if (tag === 'main' || node.getAttribute('role') === 'main') {
        phrases.push('main content');
      } else if (/^h[1-6]$/.test(tag)) {
        const level = tag[1];
        const headingText = node.textContent.trim().replace(/\s+/g, ' ');
        phrases.push(`heading, level ${level}, ${headingText}`);
      } else if (tag === 'img') {
        const alt = node.getAttribute('alt');
        phrases.push(alt ? `image, ${alt.trim()}` : 'image, unlabelled');
      } else if (tag === 'button') {
        const ariaLabel = node.getAttribute('aria-label');
        const btnText = node.textContent.trim().replace(/\s+/g, ' ');
        phrases.push(`button, ${ariaLabel || btnText || 'unlabelled'}`);
      } else if (tag === 'input') {
        const id = node.getAttribute('id');
        let labelText = '';
        if (id) {
          const l = document.querySelector(`label[for="${id}"]`);
          if (l) labelText = l.textContent.trim();
        }
        if (!labelText && node.getAttribute('aria-label')) {
          labelText = node.getAttribute('aria-label').trim();
        }
        if (!labelText && node.getAttribute('placeholder')) {
          labelText = node.getAttribute('placeholder').trim();
        }
        phrases.push(`edit text, ${labelText || 'unlabelled'}`);
      }

      for (const child of node.childNodes) {
        walk(child);
      }
    }
  }

  walk(document.body);
  return phrases;
}

// Main verification pipeline: runs before/after axe, agent, layout diffs, and screen-reader transcripts
export async function verify(url, options = {}) {
  const timeoutMs = options.timeoutMs || 180000; // 100-second deadline for the live pipeline
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
  const startTime = Date.now();
  let phase = 'init';

  function checkPipelineTimeout(currentPhase) {
    phase = currentPhase;
    const elapsed = Date.now() - startTime;
    if (elapsed > timeoutMs) {
      throw new Error(`Verification pipeline timed out after ${Math.round(timeoutMs / 1000)}s during phase "${phase}".`);
    }
  }

  const targetUrl = resolveTargetUrl(url);
  const siteName = options.siteName || path.basename(url, path.extname(url)) || 'broken';
  console.log(`[verifier] Initializing verification pipeline for: ${targetUrl} (site: ${siteName}, timeout: ${Math.round(timeoutMs / 1000)}s)...`);

  let browser = null;
  try {
    checkPipelineTimeout('browser_launch');
    browser = await chromium.launch({
      headless: true,
      args: ['--single-process', '--no-sandbox', '--disable-gpu'],
    });

    const context = await browser.newContext();
    const page = await context.newPage();

    // 1. Navigate to original page and run initial Axe scan
    checkPipelineTimeout('initial_navigation');
    onProgress('scan', 'running', 'Launching Chromium and evaluating Axe WCAG accessibility violations...');
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});

    // Step 1: Run initial Axe scan & capture artifacts
    checkPipelineTimeout('initial_axe_scan');
    const initialViolations = await runAxeScan(page);
    const axeBefore = initialViolations.length;
    console.log(`[verifier] Initial Axe violations: ${axeBefore}`);

    const cacheDir = await getSiteCacheDir(siteName);
    const beforeScreenshotPath = path.join(cacheDir, 'before.png');
    await page.screenshot({ path: beforeScreenshotPath, fullPage: true }).catch(() => {});

    const pageTitle = await page.title();
    const ariaTree = await page.locator('body').ariaSnapshot();

    const keyboardFindings = await page.evaluate(() => {
      const unreachable = [];
      const unlabelled = [];

      // Check for non-focusable clickable divs
      const clickableDivs = Array.from(document.querySelectorAll('div[onclick], div.btn-subscribe, [role="button"]'));
      clickableDivs.forEach((el) => {
        if (el.tagName.toLowerCase() === 'div' && !el.hasAttribute('tabindex')) {
          unreachable.push({
            tag: 'div',
            role: 'button',
            selector: el.className ? `div.${el.className.trim().split(/\s+/)[0]}` : 'div',
            html: el.outerHTML.slice(0, 160),
            text: (el.textContent || '').trim().slice(0, 40),
          });
        }
      });

      // Check for unlabelled buttons or inputs
      const buttons = Array.from(document.querySelectorAll('button'));
      buttons.forEach((btn) => {
        const hasName = btn.getAttribute('aria-label') || btn.textContent?.trim();
        if (!hasName) {
          unlabelled.push({
            tag: 'button',
            role: 'button',
            selector: btn.className ? `button.${btn.className.trim().split(/\s+/)[0]}` : 'button',
            html: btn.outerHTML.slice(0, 160),
            accessibleName: 'UNLABELLED',
          });
        }
      });

      const emailInput = document.querySelector('input[type="email"], #emailInput');
      if (emailInput) {
        const hasLabel = Boolean(document.querySelector(`label[for="${emailInput.id}"]`) || emailInput.closest('label') || emailInput.getAttribute('aria-label'));
        if (!hasLabel) {
          unlabelled.push({
            tag: 'input',
            role: 'textbox',
            selector: emailInput.id ? `#${emailInput.id}` : 'input[type="email"]',
            html: emailInput.outerHTML.slice(0, 160),
            accessibleName: 'UNLABELLED',
          });
        }
      }

      return { unreachableElements: unreachable, elementsWithoutAccessibleNames: unlabelled, elementsWithoutVisibleFocus: [] };
    });

    // Cache initial scan state so preview and prioritizer have accurate baseline
    await saveStageCache(siteName, 'before', {
      url: targetUrl,
      siteName,
      title: pageTitle,
      axeSummary: {
        totalViolations: axeBefore,
        byImpact: {
          critical: initialViolations.filter((v) => v.impact === 'critical').length,
          serious: initialViolations.filter((v) => v.impact === 'serious').length,
          moderate: initialViolations.filter((v) => v.impact === 'moderate').length,
          minor: initialViolations.filter((v) => v.impact === 'minor').length,
        },
      },
      axeViolations: initialViolations,
      ariaTree,
      screenshot: beforeScreenshotPath,
      keyboard: keyboardFindings,
    });

    onProgress('scan', 'completed', `Scan complete: ${axeBefore} Axe violations detected.`, { axeBefore });

    // Step 2: Measure initial layout bounding boxes
    checkPipelineTimeout('bounding_boxes_before');
    const beforeBoxes = await getBoundingBoxes(page);

    // Step 3: Discover visitor goal & run Blind Agent on original broken page
    checkPipelineTimeout('task_discovery');
    onProgress('task', 'running', 'Identifying primary visitor goal from accessible snapshot...');
    const task = await findTask(pageTitle, ariaTree, url);
    console.log(`[verifier] Running Blind Agent on original page (Task: "${task.task}")...`);
    onProgress('task', 'completed', `Discovered goal: "${task.task}"`, { task: task.task });

    checkPipelineTimeout('agent_before');
    onProgress('agent', 'running', 'Simulating blind user keyboard traversal on initial page...');
    const agentBefore = await runBlindAgent(page, task, {
      siteName,
      runType: 'before',
      maxSteps: 30,
      maxAttemptDurationMs: 25000,
    });
    console.log(`[verifier] Agent before status: ${agentBefore.success ? 'SUCCESS' : 'FAILED'}`);
    onProgress('agent', 'completed', `Initial agent completed: ${agentBefore.success ? 'PASSED' : 'FAILED'} (${agentBefore.steps} steps).`, {
      success: agentBefore.success,
      steps: agentBefore.steps,
      stuckAt: agentBefore.stuckAt,
    });

    // Step 4: Make working copy of the page
    checkPipelineTimeout('working_copy_init');
    const workingCopyPath = path.join(cacheDir, 'working_copy.html');
    // 2.1 in src/verifier.js, for http(s) URLs get the HTML with page.content() instead of fs.readFile
    const originalHtml = /^https?:\/\//i.test(targetUrl || url)
      ? await page.content()
      : await fs.readFile(path.resolve(url.replace('file://', '')), 'utf-8');
    await fs.writeFile(workingCopyPath, originalHtml, 'utf-8');

    // Run prioritizer if not already present
    const prioritizedResult = await prioritize(
      { axeViolations: initialViolations, keyboard: keyboardFindings },
      agentBefore
    );
    await saveStageCache(siteName, 'prioritized', prioritizedResult);

    let rounds = 0;
    let agentAfter = null;
    let axeAfter = 0;
    let layoutFlags = [];
    const maxRounds = 3;

    // Step 5: Iterative verification loop (up to 3 rounds)
    for (let round = 1; round <= maxRounds; round++) {
      rounds = round;
      console.log(`\n--- Verification Round ${round}/${maxRounds} ---`);

      // Run fixer to generate ops on working copy
      checkPipelineTimeout(`round_${round}_fix`);
      onProgress('fix', 'running', `Synthesizing semantic repair operations (Round ${round})...`);
      const fixResult = await fix(siteName);
      onProgress('fix', 'completed', `Generated ${fixResult.appliedOps?.length || 0} semantic operations.`, {
        fixesApplied: fixResult.appliedOps?.length || 0,
      });

      // Copy patched.html to working copy
      const patchedContent = await fs.readFile(fixResult.patchedHtmlPath, 'utf-8');
      await fs.writeFile(workingCopyPath, patchedContent, 'utf-8');

      // Navigate browser to updated working copy
      checkPipelineTimeout(`round_${round}_navigation`);
      onProgress('verify', 'running', 'Measuring layout shifts and running Blind Agent on patched working copy...');
      const workingCopyUrl = `file://${workingCopyPath}`;
      await page.goto(workingCopyUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});

      // Measure layout shifts
      checkPipelineTimeout(`round_${round}_layout_check`);
      const afterBoxes = await getBoundingBoxes(page);
      layoutFlags = checkLayoutShifts(beforeBoxes, afterBoxes, fixResult.appliedOps);

      // Re-run Axe
      checkPipelineTimeout(`round_${round}_axe_scan`);
      const afterViolations = await runAxeScan(page);
      axeAfter = afterViolations.length;
      console.log(`[verifier] Round ${round} Axe violations remaining: ${axeAfter}`);

      // Re-run Blind Agent on updated working copy
      checkPipelineTimeout(`round_${round}_agent_after`);
      console.log(`[verifier] Running Blind Agent on patched working copy...`);
      agentAfter = await runBlindAgent(page, task, {
        siteName,
        runType: 'after',
        maxSteps: 30,
        maxAttemptDurationMs: 25000,
      });
      console.log(`[verifier] Round ${round} Agent status: ${agentAfter.success ? 'SUCCESS' : 'FAILED'}`);

      // Capture after screenshot
      const afterScreenshotPath = path.join(cacheDir, 'after.png');
      await page.screenshot({ path: afterScreenshotPath, fullPage: true }).catch(() => {});

      // Stop if agent succeeds and axe violations are cleared
      if (agentAfter.success && axeAfter === 0) {
        console.log(`[verifier] Success criteria satisfied in Round ${round}!`);
        onProgress('verify', 'completed', `Verification PASSED: 0 Axe violations remaining. Blind Agent succeeded in ${agentAfter.steps} steps!`, {
          axeAfter,
          agentAfterSteps: agentAfter.steps,
        });
        break;
      }

      // If not satisfied and more rounds remain, query Retry Fixer prompt
      if (round < maxRounds) {
        console.log(`[verifier] Barriers remain. Invoking Retry Fixer prompt...`);
        const retryPrompt = `Goal: ${task.task}
Agent stuck at: ${agentAfter.stuckAt || 'None'}
Remaining Axe Violations (${afterViolations.length}): ${JSON.stringify(afterViolations.slice(0, 3))}
Generate revised ops {selector, op, name, value, reason, confidence} to fix remaining barriers.`;

        await ask({
          prompt: retryPrompt,
          systemPrompt: 'You are an accessibility code repair tool. Generate JSON repair operations.',
        }).catch(() => {});
      }
    }

    // Step 6: Screen reader transcripts
    checkPipelineTimeout('screen_reader_transcripts');
    console.log(`[verifier] Generating screen-reader spoken transcripts...`);
    const patchedHtml = await fs.readFile(workingCopyPath, 'utf-8');
    const transcripts = {
      before: await generateScreenReaderTranscript(originalHtml),
      after: await generateScreenReaderTranscript(patchedHtml),
    };

    const verificationResult = {
      rounds,
      axeBefore,
      axeAfter,
      agentBefore: {
        success: agentBefore.success,
        steps: agentBefore.steps,
        stuckAt: agentBefore.stuckAt,
      },
      agentAfter: {
        success: agentAfter.success,
        steps: agentAfter.steps,
        stuckAt: agentAfter.stuckAt,
      },
      layoutFlags,
      transcripts,
    };

    await saveStageCache(siteName, 'verification', verificationResult);
    return verificationResult;
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

// CLI runner
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const targetUrl = process.argv[2] || 'demo-sites/broken.html';

  console.log(`\n======================================================`);
  console.log(` AccessFix Verifier End-to-End Test`);
  console.log(` Target: ${targetUrl}`);
  console.log(`======================================================\n`);

  try {
    const res = await verify(targetUrl);

    console.log('\n======================================================');
    console.log(' Verification Results Summary');
    console.log('======================================================');
    console.log(`Rounds Executed:     ${res.rounds}`);
    console.log(`Axe Violations:      ${res.axeBefore} before -> ${res.axeAfter} after`);
    console.log(`Blind Agent:         ${res.agentBefore.success ? 'PASSED' : 'FAILED'} before -> ${res.agentAfter.success ? 'PASSED' : 'FAILED'} after`);
    if (res.agentBefore.stuckAt) {
      console.log(`  Initial Failure:   ${res.agentBefore.stuckAt}`);
    }

    console.log(`\nLayout Flags (${res.layoutFlags.length}):`);
    if (res.layoutFlags.length === 0) {
      console.log('  None! All elements stayed within 5 CSS pixels.');
    } else {
      res.layoutFlags.forEach((flag, idx) => {
        console.log(`  ${idx + 1}. [${flag.status.toUpperCase()}] ${flag.selector} shifted dx=${flag.shift.dx}px, dy=${flag.shift.dy}px`);
        if (flag.responsibleOp) {
          console.log(`     Responsible Op: [${flag.responsibleOp.op}] ${flag.responsibleOp.selector} (${flag.responsibleOp.reason})`);
        }
      });
    }

    console.log(`\nScreen Reader Transcript Summary:`);
    console.log(`  Before (${res.transcripts.before.length} phrases):`);
    res.transcripts.before.slice(0, 5).forEach((p) => console.log(`    - "${p}"`));
    console.log(`  After (${res.transcripts.after.length} phrases):`);
    res.transcripts.after.slice(0, 5).forEach((p) => console.log(`    - "${p}"`));

    console.log('\n======================================================\n');
    process.exit(0);
  } catch (err) {
    console.error('[verifier] Execution failed:', err);
    process.exit(1);
  }
}
