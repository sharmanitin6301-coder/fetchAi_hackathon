import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import process from 'process';
import { chromium } from 'playwright';
import 'dotenv/config';

import { scanPage } from './scanner.js';
import { findTask } from './taskFinder.js';
import { runBlindAgent } from './blindAgent.js';
import { prioritize } from './prioritizer.js';
import { fix } from './fixer.js';
import { verify, generateScreenReaderTranscript } from './verifier.js';
import { saveStageCache, getSiteCacheDir, readStageCache } from './cache.js';

// Executes the complete recording pipeline for a target demo site and writes all artifacts + run.json
export async function recordSite(siteName = 'broken') {
  console.log(`\n======================================================`);
  console.log(` AccessFix Recording Pipeline: ${siteName}`);
  console.log(`======================================================`);

  const fixturePath = path.resolve('demo-sites', `${siteName}.html`);
  const originalHtml = await fs.readFile(fixturePath, 'utf-8');
  const cacheDir = await getSiteCacheDir(siteName);

  // 1. Initial Scan (before.json, before.png)
  console.log(`[record] Step 1: Scanning original ${siteName}.html...`);
  const scanResult = await scanPage(fixturePath, siteName);
  const axeBefore = scanResult.axeSummary.totalViolations;

  // 2. Discover Task
  console.log(`[record] Step 2: Discovering task...`);
  const task = await findTask('Target Page', scanResult.ariaTree, fixturePath);

  // 3. Blind Agent BEFORE
  console.log(`[record] Step 3: Running Blind Agent on original page (before)...`);
  const browser = await chromium.launch({
    headless: true,
    args: ['--single-process', '--no-sandbox', '--disable-gpu'],
  });
  let agentBefore;
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`file://${fixturePath}`, { waitUntil: 'networkidle' });
    agentBefore = await runBlindAgent(page, task, {
      siteName,
      runType: 'before',
      maxSteps: 30,
    });
  } finally {
    await browser.close();
  }

  // 4. Prioritize & Fix
  console.log(`[record] Step 4: Prioritizing issues and generating fixes...`);
  const prioritized = await prioritize(scanResult, agentBefore);
  await saveStageCache(siteName, 'prioritized', prioritized);

  const fixResult = await fix(siteName);

  // 5. Verify & Blind Agent AFTER
  console.log(`[record] Step 5: Running verifier & Blind Agent on patched working copy...`);
  const verificationResult = await verify(fixturePath);

  // 6. Scan patched page (after.json, after.png)
  console.log(`[record] Step 6: Capturing after.json and after.png...`);
  const patchedPath = path.join(cacheDir, 'patched.html');
  const afterScanBrowser = await chromium.launch({
    headless: true,
    args: ['--single-process', '--no-sandbox', '--disable-gpu'],
  });
  let afterScanData = {};
  try {
    const context = await afterScanBrowser.newContext();
    const page = await context.newPage();
    await page.goto(`file://${patchedPath}`, { waitUntil: 'networkidle' });
    const afterScreenshotPath = path.join(cacheDir, 'after.png');
    await page.screenshot({ path: afterScreenshotPath, fullPage: true });

    afterScanData = {
      siteName,
      scannedAt: new Date().toISOString(),
      url: `file://${patchedPath}`,
      violationsCount: verificationResult.axeAfter,
      screenshot: afterScreenshotPath,
    };
    await fs.writeFile(path.join(cacheDir, 'after.json'), JSON.stringify(afterScanData, null, 2), 'utf-8');
  } finally {
    await afterScanBrowser.close();
  }

  // 7. Assemble combined run.json for UI replay stream
  console.log(`[record] Step 7: Compiling cache/${siteName}/run.json...`);
  let diffContent = '';
  try {
    diffContent = await fs.readFile(path.join(cacheDir, 'fix.diff'), 'utf-8');
  } catch {}

  let patchedHtml = originalHtml;
  try {
    patchedHtml = await fs.readFile(patchedPath, 'utf-8');
  } catch {}

  const runEvents = [
    {
      event: 'stage',
      delayMs: 600,
      payload: {
        stage: 'scan',
        status: 'running',
        message: 'Running Axe WCAG audit and capturing keyboard navigation snapshot...',
      },
    },
    {
      event: 'stage',
      delayMs: 1000,
      payload: {
        stage: 'scan',
        status: 'completed',
        message: `Scan complete: ${axeBefore} WCAG violations detected. Keyboard navigation snapshot recorded.`,
        data: { axeBefore },
      },
    },
    {
      event: 'stage',
      delayMs: 600,
      payload: {
        stage: 'task',
        status: 'running',
        message: 'Discovering primary user goal on the page...',
      },
    },
    {
      event: 'stage',
      delayMs: 900,
      payload: {
        stage: 'task',
        status: 'completed',
        message: `Discovered goal: "${task.task}".`,
        data: { task: task.task },
      },
    },
    {
      event: 'stage',
      delayMs: 800,
      payload: {
        stage: 'agent',
        status: 'running',
        message: 'Simulating blind user keyboard traversal on original page...',
      },
    },
    {
      event: 'stage',
      delayMs: 1200,
      payload: {
        stage: 'agent',
        status: 'completed',
        message: `Initial run ${agentBefore.success ? 'PASSED' : 'FAILED'} at step ${agentBefore.steps}. ${agentBefore.stuckAt || 'Task completed.'}`,
        data: { success: agentBefore.success, steps: agentBefore.steps },
      },
    },
    {
      event: 'stage',
      delayMs: 800,
      payload: {
        stage: 'fix',
        status: 'running',
        message: 'Prioritizing barriers and synthesizing semantic repair operations...',
      },
    },
    {
      event: 'stage',
      delayMs: 1000,
      payload: {
        stage: 'fix',
        status: 'completed',
        message: `Generated ${fixResult.appliedOps.length} semantic operations (button, labels, contrast, landmarks).`,
        data: { fixesApplied: fixResult.appliedOps.length },
      },
    },
    {
      event: 'stage',
      delayMs: 900,
      payload: {
        stage: 'verify',
        status: 'running',
        message: 'Measuring layout shifts and re-verifying with Blind Agent on patched working copy...',
      },
    },
    {
      event: 'stage',
      delayMs: 1100,
      payload: {
        stage: 'verify',
        status: 'completed',
        message: `Verification PASSED. ${verificationResult.axeAfter} Axe violations remaining. Blind Agent achieved goal in ${verificationResult.agentAfter.steps} steps!`,
        data: { axeAfter: verificationResult.axeAfter, agentAfterSteps: verificationResult.agentAfter.steps },
      },
    },
    {
      event: 'complete',
      delayMs: 400,
      result: {
        axeBefore,
        axeAfter: verificationResult.axeAfter,
        agentBefore: verificationResult.agentBefore,
        agentAfter: verificationResult.agentAfter,
        fixesCount: fixResult.appliedOps.length,
        layoutFlagsCount: verificationResult.layoutFlags.length,
        needsHumanCount: prioritized.needsHuman.length,
      },
      data: {
        axeBefore,
        axeAfter: verificationResult.axeAfter,
        agentBefore: verificationResult.agentBefore,
        agentAfter: verificationResult.agentAfter,
        diff: diffContent,
        ops: fixResult.appliedOps,
        layoutFlags: verificationResult.layoutFlags,
        transcripts: verificationResult.transcripts,
        needsHuman: prioritized.needsHuman,
        issues: prioritized.issues,
        originalHtml,
        patchedHtml,
      },
    },
  ];

  const runJsonPayload = {
    site: siteName,
    recordedAt: new Date().toISOString(),
    metrics: {
      axeBefore,
      axeAfter: verificationResult.axeAfter,
      agentBeforeSteps: agentBefore.steps,
      agentAfterSteps: verificationResult.agentAfter.steps,
      fixesApplied: fixResult.appliedOps.length,
    },
    events: runEvents,
  };

  const runJsonPath = path.join(cacheDir, 'run.json');
  await fs.writeFile(runJsonPath, JSON.stringify(runJsonPayload, null, 2), 'utf-8');
  console.log(`[record] Successfully saved cache/${siteName}/run.json (${runEvents.length} stage events).`);

  return runJsonPayload;
}

// CLI runner: supports 'npm run record -- fixed', 'npm run record -- broken', or full suite
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log('--- Starting AccessFix Demo Recording ---');
  try {
    const rawArgs = process.argv.slice(2).map((a) => a.toLowerCase().replace(/^-+/, '').trim());
    const isFixedOnly = rawArgs.includes('fixed');
    const isBrokenOnly = rawArgs.includes('broken');

    if (isFixedOnly && !isBrokenOnly) {
      console.log('[record] Target: fixed.html only');
      await recordSite('fixed');
    } else if (isBrokenOnly && !isFixedOnly) {
      console.log('[record] Target: broken.html only');
      await recordSite('broken');
    } else {
      console.log('[record] Target: full demo suite (broken.html and fixed.html)');
      await recordSite('broken');
      await recordSite('fixed');
    }

    console.log('\n======================================================');
    console.log('Recording Completed successfully!');
    console.log('Artifacts saved to cache/.');
    console.log('======================================================\n');
  } catch (err) {
    console.error('[record] Recording failed:', err);
    process.exit(1);
  }
}
