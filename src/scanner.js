import path from 'path';
import { fileURLToPath } from 'url';
import process from 'process';
import { chromium } from 'playwright';
import { AxeBuilder } from '@axe-core/playwright';
import { saveStageCache, getSiteCacheDir } from './cache.js';

// Normalizes web URL or relative/absolute local filesystem path into a valid URL
export function resolveTargetUrl(urlOrPath) {
  if (/^https?:\/\//i.test(urlOrPath) || urlOrPath.startsWith('file://')) {
    return urlOrPath;
  }
  const absolute = path.resolve(urlOrPath);
  return `file://${absolute}`;
}

// Executes Axe WCAG accessibility evaluation
export async function runAxeScan(page) {
  // We include best-practice alongside WCAG tags so heading-order and landmarks are checked
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag22aa', 'best-practice'])
    .analyze();

  return results.violations.map((v) => ({
    id: v.id,
    impact: v.impact || 'minor',
    tags: v.tags.filter((t) => t.startsWith('wcag') || t === 'best-practice'),
    description: v.description,
    nodes: v.nodes.map((n) => ({
      html: n.html,
      target: Array.isArray(n.target) ? n.target.join(' ') : n.target,
      failureSummary: n.failureSummary,
    })),
  }));
}

// Captures accessible snapshot tree using ariaSnapshot
export async function captureAriaSnapshot(page) {
  return await page.locator('body').ariaSnapshot();
}

// Simulates sequential Tab key presses to detect unreachable controls, traps, and missing focus indicators
export async function runTabTraversal(page, maxTabs = 60) {
  // Mark and catalog all candidate interactive elements on the page
  const candidates = await page.evaluate(() => {
    const selector = 'a[href], button, input:not([type="hidden"]), select, textarea, [onclick], [role="button"], [tabindex]';
    const items = Array.from(document.querySelectorAll(selector));
    return items.map((el, idx) => {
      el.setAttribute('data-accessfix-id', String(idx));
      return {
        id: String(idx),
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute('role') || el.tagName.toLowerCase(),
        selector: el.id ? `#${el.id}` : (el.className && typeof el.className === 'string') ? `${el.tagName.toLowerCase()}.${el.className.trim().split(/\s+/)[0]}` : el.tagName.toLowerCase(),
        html: el.outerHTML.slice(0, 160),
        text: (el.textContent || '').trim().slice(0, 40),
      };
    });
  });

  const tabHistory = [];

  for (let step = 0; step < maxTabs; step++) {
    await page.keyboard.press('Tab');

    const focusedInfo = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body || el === document.documentElement) return null;

      const candidateId = el.getAttribute('data-accessfix-id') || null;

      // Determine accessible name per standard priority order
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
      if (!name && el.closest('label')) name = el.closest('label').textContent.trim();
      if (!name && el.getAttribute('alt')) name = el.getAttribute('alt').trim();
      if (!name && el.getAttribute('title')) name = el.getAttribute('title').trim();
      if (!name && el.textContent) name = el.textContent.trim().replace(/\s+/g, ' ');

      // Compare focused vs unfocused computed outline & shadow
      const computedFocused = window.getComputedStyle(el);
      const fOutline = `${computedFocused.outlineStyle} ${computedFocused.outlineWidth}`;
      const fShadow = computedFocused.boxShadow;

      el.blur();
      const computedUnfocused = window.getComputedStyle(el);
      const uOutline = `${computedUnfocused.outlineStyle} ${computedUnfocused.outlineWidth}`;
      const uShadow = computedUnfocused.boxShadow;
      el.focus();

      const outlineChanged = fOutline !== uOutline && computedFocused.outlineStyle !== 'none' && parseFloat(computedFocused.outlineWidth) > 0;
      const shadowChanged = fShadow !== uShadow && computedFocused.boxShadow && computedFocused.boxShadow !== 'none';
      const hasVisibleFocusIndicator = outlineChanged || shadowChanged || (computedFocused.outlineStyle !== 'none' && parseFloat(computedFocused.outlineWidth) > 0);

      // Generate concise selector
      let selector = el.tagName.toLowerCase();
      if (el.id) {
        selector = `#${el.id}`;
      } else if (el.className && typeof el.className === 'string') {
        const firstClass = el.className.trim().split(/\s+/).filter(Boolean)[0];
        if (firstClass) selector += `.${firstClass}`;
      }

      return {
        candidateId,
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute('role') || el.tagName.toLowerCase(),
        accessibleName: name || 'UNLABELLED',
        selector,
        hasVisibleFocusIndicator,
        html: el.outerHTML.slice(0, 160),
      };
    });

    if (focusedInfo) {
      tabHistory.push(focusedInfo);
    }
  }

  // Identify interactive elements never reached by Tab
  const reachedIds = new Set(tabHistory.map((h) => h.candidateId).filter(Boolean));
  const unreachableElements = candidates
    .filter((c) => !reachedIds.has(c.id))
    .map((c) => ({
      tag: c.tag,
      role: c.role,
      selector: c.selector,
      text: c.text,
      html: c.html,
    }));

  // Detect keyboard focus trap (identical element repeated >= 3 times consecutively)
  let focusTrapDetected = null;
  for (let i = 2; i < tabHistory.length; i++) {
    if (
      tabHistory[i].selector === tabHistory[i - 1].selector &&
      tabHistory[i].selector === tabHistory[i - 2].selector
    ) {
      focusTrapDetected = tabHistory[i].selector;
      break;
    }
  }

  // Deduplicate elements with missing focus indicators
  const missingFocusMap = new Map();
  for (const item of tabHistory) {
    if (!item.hasVisibleFocusIndicator && !missingFocusMap.has(item.selector)) {
      missingFocusMap.set(item.selector, item);
    }
  }

  // Deduplicate unlabelled focused elements
  const unlabelledMap = new Map();
  for (const item of tabHistory) {
    if (item.accessibleName === 'UNLABELLED' && !unlabelledMap.has(item.selector)) {
      unlabelledMap.set(item.selector, item);
    }
  }

  return {
    totalTabs: tabHistory.length,
    tabHistory,
    unreachableElements,
    focusTrap: focusTrapDetected,
    elementsWithoutVisibleFocus: Array.from(missingFocusMap.values()),
    elementsWithoutAccessibleNames: Array.from(unlabelledMap.values()),
  };
}

// Scans an entire page: runs axe, captures aria tree, executes keyboard tab traversal, saves screenshot and cache
export async function scanPage(urlOrPath, siteName) {
  const targetUrl = resolveTargetUrl(urlOrPath);
  const targetSiteName = siteName || path.basename(urlOrPath, path.extname(urlOrPath)) || 'site';

  // Use single-process flags to ensure reliable execution inside sandboxed environments
  const browser = await chromium.launch({
    headless: true,
    args: ['--single-process', '--no-sandbox', '--disable-gpu'],
  });

  try {
    const context = await browser.newContext();
    const page = await context.newPage();

    // Navigate to target
    await page.goto(targetUrl, { waitUntil: 'networkidle' });

    // Step 2: Axe scan
    const axeViolations = await runAxeScan(page);

    // Step 3: Accessibility tree via ariaSnapshot
    const ariaTree = await captureAriaSnapshot(page);

    // Step 4: Tab traversal analysis
    const keyboardAnalysis = await runTabTraversal(page, 60);

    // Step 5: Full-page screenshot
    const cacheDir = await getSiteCacheDir(targetSiteName);
    const screenshotPath = path.join(cacheDir, 'before.png');
    await page.screenshot({ path: screenshotPath, fullPage: true });

    // Step 6: Assemble output object
    const scanResult = {
      siteName: targetSiteName,
      url: targetUrl,
      scannedAt: new Date().toISOString(),
      axeSummary: {
        totalViolations: axeViolations.length,
        byImpact: {
          critical: axeViolations.filter((v) => v.impact === 'critical').length,
          serious: axeViolations.filter((v) => v.impact === 'serious').length,
          moderate: axeViolations.filter((v) => v.impact === 'moderate').length,
          minor: axeViolations.filter((v) => v.impact === 'minor').length,
        },
      },
      axeViolations,
      ariaTree,
      keyboard: keyboardAnalysis,
      screenshot: screenshotPath,
    };

    // Save cache to cache/<siteName>/before.json
    await saveStageCache(targetSiteName, 'before', scanResult);

    return scanResult;
  } finally {
    await browser.close();
  }
}

// Formats and prints a readable scan summary to the console
export function printScanSummary(scanResult) {
  console.log('\n======================================================');
  console.log(` AccessFix Scan Summary: ${scanResult.siteName}`);
  console.log('======================================================');
  console.log(`URL: ${scanResult.url}`);
  console.log(`Total Axe Violations: ${scanResult.axeSummary.totalViolations}`);
  console.log(
    `Impact: critical=${scanResult.axeSummary.byImpact.critical}, serious=${scanResult.axeSummary.byImpact.serious}, moderate=${scanResult.axeSummary.byImpact.moderate}, minor=${scanResult.axeSummary.byImpact.minor}`
  );

  console.log('\n--- Axe Violations ---');
  if (scanResult.axeViolations.length === 0) {
    console.log('  None! All automated accessibility checks passed.');
  } else {
    for (const v of scanResult.axeViolations) {
      console.log(`  [${v.impact.toUpperCase()}] ${v.id}: ${v.description}`);
      for (const node of v.nodes.slice(0, 2)) {
        console.log(`    Target: ${node.target}`);
      }
    }
  }

  console.log('\n--- Keyboard Navigation Barriers ---');
  console.log(`Unreachable Elements (${scanResult.keyboard.unreachableElements.length}):`);
  if (scanResult.keyboard.unreachableElements.length === 0) {
    console.log('  None! All interactive elements are reachable via Tab.');
  } else {
    for (const el of scanResult.keyboard.unreachableElements) {
      console.log(`  - <${el.tag}> (selector: ${el.selector}, text: "${el.text}")`);
      console.log(`    Snippet: ${el.html}`);
    }
  }

  console.log(`\nFocused Elements Without Accessible Name (${scanResult.keyboard.elementsWithoutAccessibleNames.length}):`);
  if (scanResult.keyboard.elementsWithoutAccessibleNames.length === 0) {
    console.log('  None! All focusable elements have accessible names.');
  } else {
    for (const el of scanResult.keyboard.elementsWithoutAccessibleNames) {
      console.log(`  - ${el.selector} (role: ${el.role}) -> UNLABELLED`);
    }
  }

  console.log(`\nFocused Elements Without Visible Focus Indicator (${scanResult.keyboard.elementsWithoutVisibleFocus.length}):`);
  if (scanResult.keyboard.elementsWithoutVisibleFocus.length === 0) {
    console.log('  None! All focused elements show visible focus indicators.');
  } else {
    for (const el of scanResult.keyboard.elementsWithoutVisibleFocus) {
      console.log(`  - ${el.selector}`);
    }
  }

  if (scanResult.keyboard.focusTrap) {
    console.log(`\n[WARNING] Keyboard focus trap detected at: ${scanResult.keyboard.focusTrap}`);
  }

  console.log(`\nArtifacts:`);
  console.log(`  Data:       cache/${scanResult.siteName}/before.json`);
  console.log(`  Screenshot: cache/${scanResult.siteName}/before.png`);
  console.log('======================================================\n');
}

// CLI runner
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const targetArg = process.argv[2] || 'demo-sites/broken.html';
  const siteArg = process.argv[3] || (targetArg.includes('fixed') ? 'fixed' : 'broken');

  console.log(`[scanner] Scanning ${targetArg} (site: ${siteArg})...`);
  try {
    const result = await scanPage(targetArg, siteArg);
    printScanSummary(result);
  } catch (err) {
    console.error('[scanner] Scan failed:', err);
    process.exit(1);
  }
}
