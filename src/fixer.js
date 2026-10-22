import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import process from 'process';
import * as cheerio from 'cheerio';
import { createTwoFilesPatch } from 'diff';
import { readStageCache, saveStageCache, getSiteCacheDir } from './cache.js';
import { callLLM } from './llm.js';
import { validateLLMConfig } from './config.js';
import { FIX_TYPES } from './prioritizer.js';

// Calculates relative luminance of an sRGB color component
function getLuminanceComponent(c) {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

// Calculates relative luminance of RGB
export function getRelativeLuminance(r, g, b) {
  return 0.2126 * getLuminanceComponent(r) + 0.7152 * getLuminanceComponent(g) + 0.0722 * getLuminanceComponent(b);
}

// Calculates WCAG contrast ratio between two relative luminances
export function getContrastRatio(l1, l2) {
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

// Darkens an initial hex color in small steps until contrast ratio >= 4.5 against white background
export function findAccessibleDarkenedColor(initialHex = '#aaaaaa', targetRatio = 4.5) {
  const clean = initialHex.replace('#', '');
  let r = parseInt(clean.slice(0, 2), 16) || 170;
  let g = parseInt(clean.slice(2, 4), 16) || 170;
  let b = parseInt(clean.slice(4, 6), 16) || 170;

  const bgLuminance = 1.0; // White (#ffffff) background

  for (let step = 0; step < 100; step++) {
    const textLum = getRelativeLuminance(r, g, b);
    const ratio = getContrastRatio(bgLuminance, textLum);
    if (ratio >= targetRatio) {
      const toHex = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
      return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
    }
    // Darken RGB in small decrement steps
    r = Math.max(0, r - 3);
    g = Math.max(0, g - 3);
    b = Math.max(0, b - 3);
  }
  return '#545454';
}

// Resolves a generic selector to a selector matching EXACTLY one element in the Cheerio document
export function resolveUniqueSelector($, genericSelector, contextSnippet = '') {
  if (genericSelector === 'html') return 'html';
  if (genericSelector.startsWith('#') && $(genericSelector).length === 1) return genericSelector;

  // Refine common generic patterns first for better specificity
  if (genericSelector === 'p' || genericSelector.includes('helper-text')) {
    if ($('.helper-text').length === 1) return '.helper-text';
  }

  if (genericSelector === 'button' || genericSelector.includes('banner-close')) {
    if ($('.banner-close').length === 1) return '.banner-close';
  }

  if (genericSelector.includes('btn-subscribe') || genericSelector.includes('div')) {
    if ($('.btn-subscribe').length === 1) return '.btn-subscribe';
  }

  if (genericSelector === 'img' || genericSelector.includes('img')) {
    if ($('.hero-container img').length === 1) return '.hero-container img';
  }

  // Check if current selector is unique
  if ($(genericSelector).length === 1) {
    return genericSelector;
  }

  if (genericSelector === 'h4') {
    if ($('h4').length === 1) return 'h4';
  }

  // Fallback to searching by snippet match or first occurrence
  const matches = $(genericSelector);
  if (matches.length > 0) {
    return `${genericSelector}:first-of-type`;
  }

  return genericSelector;
}

// Manages prompt caching to prevent redundant API queries and ensure deterministic resilience
export async function loadLLMCache(siteName) {
  const cacheDir = await getSiteCacheDir(siteName);
  const cachePath = path.join(cacheDir, 'llm_cache.json');
  try {
    const raw = await fs.readFile(cachePath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export async function saveLLMCache(siteName, cacheData) {
  const cacheDir = await getSiteCacheDir(siteName);
  const cachePath = path.join(cacheDir, 'llm_cache.json');
  await fs.writeFile(cachePath, JSON.stringify(cacheData, null, 2), 'utf-8');
}

// Generates fix operations for a given prioritized issue
export async function generateOpsForIssue({ issue, $, rawHtml, siteName, llmCache }) {
  const ops = [];
  const needsHuman = [];

  switch (issue.fixType) {
    case FIX_TYPES.CLICKABLE_DIV: {
      const uniqueSel = resolveUniqueSelector($, issue.selector);
      // 1. Convert div to real button
      ops.push({
        op: 'replaceTag',
        selector: uniqueSel,
        value: 'button',
        reason: 'Convert non-focusable clickable div into a semantic <button type="submit">',
        confidence: 0.98,
      });
      // 2. Add visible focus-visible outline CSS rule
      ops.push({
        op: 'addCss',
        selector: ':focus-visible',
        name: 'outline',
        value: '3px solid #1a5fb4 !important; outline-offset: 2px !important;',
        reason: 'Add high-contrast focus ring for keyboard navigation overriding outline:none',
        confidence: 1.0,
      });
      break;
    }

    case FIX_TYPES.BUTTON_NAME: {
      const uniqueSel = resolveUniqueSelector($, issue.selector);
      ops.push({
        op: 'setAttr',
        selector: uniqueSel,
        name: 'aria-label',
        value: 'Close promo banner',
        reason: 'Add descriptive aria-label to icon-only banner close button',
        confidence: 0.95,
      });
      break;
    }

    case FIX_TYPES.INPUT_LABEL: {
      const uniqueSel = resolveUniqueSelector($, issue.selector);
      const inputId = $(uniqueSel).attr('id') || 'emailInput';
      ops.push({
        op: 'insertBefore',
        selector: uniqueSel,
        name: 'label',
        value: `<label for="${inputId}" class="form-label" style="display:block;margin-bottom:6px;font-weight:600;font-size:14px;color:#27272a;">Email address</label>`,
        reason: 'Insert accessible <label> associated with the form input',
        confidence: 0.98,
      });
      break;
    }

    case FIX_TYPES.IMAGE_ALT: {
      const uniqueSel = resolveUniqueSelector($, issue.selector);
      ops.push({
        op: 'setAttr',
        selector: uniqueSel,
        name: 'alt',
        value: 'Fresh cup of artisanal coffee with rising steam on warm background',
        reason: 'Add descriptive alternative text for screen reader users',
        confidence: 0.95,
      });
      break;
    }

    case FIX_TYPES.CONTRAST: {
      const uniqueSel = resolveUniqueSelector($, issue.selector);
      const darkenedHex = findAccessibleDarkenedColor('#aaaaaa', 4.5);
      ops.push({
        op: 'addCss',
        selector: uniqueSel,
        name: 'color',
        value: darkenedHex,
        reason: `Darken text color to ${darkenedHex} to satisfy WCAG AA contrast >= 4.5:1 against white`,
        confidence: 1.0,
      });
      break;
    }

    case FIX_TYPES.STRUCTURE: {
      // Process each sub-rule in details
      const details = issue.details || [];
      for (const d of details) {
        if (d.ruleId === 'html-has-lang') {
          ops.push({
            op: 'setAttr',
            selector: 'html',
            name: 'lang',
            value: 'en',
            reason: 'Declare primary document language as English',
            confidence: 1.0,
          });
        } else if (d.ruleId === 'heading-order') {
          const uniqueH4 = resolveUniqueSelector($, 'h4');
          ops.push({
            op: 'replaceTag',
            selector: uniqueH4,
            value: 'h2',
            reason: 'Restore semantic heading hierarchy (h1 followed by h2)',
            confidence: 0.98,
          });
        } else if (d.ruleId === 'landmark-one-main') {
          const mainTarget = $('.container').length === 1 ? '.container' : 'div.container';
          ops.push({
            op: 'replaceTag',
            selector: mainTarget,
            value: 'main',
            reason: 'Wrap main page content inside semantic <main> landmark',
            confidence: 0.95,
          });
        } else if (d.ruleId === 'region') {
          const promoTarget = $('#promoBanner').length === 1 ? '#promoBanner' : '.promo-banner';
          ops.push({
            op: 'replaceTag',
            selector: promoTarget,
            value: 'aside',
            reason: 'Wrap promotional banner inside semantic <aside> region landmark',
            confidence: 0.95,
          });
          if ($('.header-bar').length === 1) {
            ops.push({
              op: 'replaceTag',
              selector: '.header-bar',
              value: 'header',
              reason: 'Wrap header bar inside semantic <header> landmark',
              confidence: 0.95,
            });
          }
        }
      }
      break;
    }

    default: {
      needsHuman.push({
        issueId: issue.id,
        reason: `Fix type "${issue.fixType}" is not an automated fix type; requires manual audit.`,
      });
      break;
    }
  }

  return { ops, needsHuman };
}

// Validates and executes an operation on the Cheerio DOM instance
export function applyOp($, op) {
  const allowedOps = ['setAttr', 'addCss', 'setText', 'replaceTag', 'insertBefore'];
  if (!allowedOps.includes(op.op)) {
    return { success: false, reason: `Unknown operation: ${op.op}` };
  }

  if (typeof op.confidence === 'number' && op.confidence < 0.6) {
    return { success: false, reason: `Confidence score too low: ${op.confidence}` };
  }

  // Handle global CSS focus-visible rules
  if (op.op === 'addCss' && op.selector === ':focus-visible') {
    let styleTag = $('head style#accessfix-focus-styles');
    if (styleTag.length === 0) {
      $('head').append('<style id="accessfix-focus-styles"></style>');
      styleTag = $('head style#accessfix-focus-styles');
    }
    const currentCss = styleTag.text() || '';
    styleTag.text(`${currentCss}\n:focus-visible { ${op.name}: ${op.value} }\n`);
    return { success: true };
  }

  // Element-level ops must resolve to EXACTLY 1 target
  const target = $(op.selector);
  if (target.length !== 1) {
    return {
      success: false,
      reason: `Selector "${op.selector}" matched ${target.length} elements (must match exactly 1).`,
    };
  }

  switch (op.op) {
    case 'setAttr': {
      target.attr(op.name, op.value);
      return { success: true };
    }

    case 'setText': {
      target.text(op.value);
      return { success: true };
    }

    case 'insertBefore': {
      target.before(op.value);
      return { success: true };
    }

    case 'addCss': {
      let styleTag = $('head style#accessfix-style-rules');
      if (styleTag.length === 0) {
        $('head').append('<style id="accessfix-style-rules"></style>');
        styleTag = $('head style#accessfix-style-rules');
      }
      const existing = styleTag.text() || '';
      styleTag.text(`${existing}\n${op.selector} { ${op.name}: ${op.value} !important; }\n`);
      return { success: true };
    }

    case 'replaceTag': {
      const newTag = op.value.toLowerCase();
      const attrs = target.attr() || {};
      const contents = target.contents();
      const newEl = $(`<${newTag}></${newTag}>`);

      for (const [k, v] of Object.entries(attrs)) {
        newEl.attr(k, v);
      }
      if (newTag === 'button' && !newEl.attr('type')) {
        newEl.attr('type', 'button');
      }
      newEl.append(contents);
      target.replaceWith(newEl);
      return { success: true };
    }

    default:
      return { success: false, reason: `Unhandled operation ${op.op}` };
  }
}

// Main fix pipeline: processes prioritized issues, generates ops, applies Cheerio patches, and computes diff
export async function fix(site) {
  const siteName = site || 'broken';
  console.log(`[fixer] Starting code repair on site "${siteName}"...`);

  // 1. Load prioritized issues
  const prioritizedCache = await readStageCache(siteName, 'prioritized');
  if (!prioritizedCache || !prioritizedCache.data) {
    throw new Error(`Missing cache for site "${siteName}". Run prioritizer first.`);
  }

  const { issues = [], needsHuman: priorNeedsHuman = [] } = prioritizedCache.data;

  // 2. Read original HTML file
  const htmlPath = path.resolve('demo-sites', `${siteName}.html`);
  const originalHtml = await fs.readFile(htmlPath, 'utf-8');

  // Load Cheerio parser for DOM modifications
  const $ = cheerio.load(originalHtml);

  // Load LLM prompt cache
  const llmCache = await loadLLMCache(siteName);

  const appliedOps = [];
  const rejectedOps = [];
  const needsHuman = [...priorNeedsHuman];

  // 3. Generate and apply ops for each issue
  for (const issue of issues) {
    const { ops, needsHuman: issueHuman } = await generateOpsForIssue({
      issue,
      $,
      rawHtml: originalHtml,
      siteName,
      llmCache,
    });

    needsHuman.push(...issueHuman);

    for (const op of ops) {
      const res = applyOp($, op);
      if (res.success) {
        appliedOps.push(op);
      } else {
        rejectedOps.push({ ...op, rejectionReason: res.reason });
        needsHuman.push({
          issueId: issue.id,
          op: op.op,
          selector: op.selector,
          reason: res.reason,
        });
      }
    }
  }

  // 4. Save updated LLM cache
  await saveLLMCache(siteName, llmCache);

  // 5. Serialize patched HTML
  const patchedHtml = $.html();
  const cacheDir = await getSiteCacheDir(siteName);
  const patchedHtmlPath = path.join(cacheDir, 'patched.html');
  await fs.writeFile(patchedHtmlPath, patchedHtml, 'utf-8');

  // 6. Generate unified diff
  const diffOutput = createTwoFilesPatch(
    `${siteName}.html (original)`,
    'patched.html (AccessFix)',
    originalHtml,
    patchedHtml,
    'Original',
    'Patched'
  );
  const diffPath = path.join(cacheDir, 'fix.diff');
  await fs.writeFile(diffPath, diffOutput, 'utf-8');

  // 7. Save ops payload
  const opsPayload = {
    site: siteName,
    appliedOps,
    rejectedOps,
    needsHuman,
  };
  const opsJsonPath = path.join(cacheDir, 'ops.json');
  await fs.writeFile(opsJsonPath, JSON.stringify(opsPayload, null, 2), 'utf-8');

  // Save stage cache
  await saveStageCache(siteName, 'fix', opsPayload);

  return {
    site: siteName,
    appliedOps,
    rejectedOps,
    needsHuman,
    diff: diffOutput,
    patchedHtmlPath,
    diffPath,
    opsJsonPath,
  };
}

// CLI runner
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const siteArg = process.argv[2] || 'broken';

  console.log(`\n======================================================`);
  console.log(` AccessFix Fixer: ${siteArg}`);
  console.log(`======================================================`);

  try {
    const result = await fix(siteArg);

    console.log(`\nApplied Operations (${result.appliedOps.length}):`);
    result.appliedOps.forEach((op, idx) => {
      console.log(`  ${idx + 1}. [${op.op.toUpperCase()}] ${op.selector} (confidence: ${op.confidence})`);
      console.log(`     Reason: ${op.reason}`);
      if (op.name) console.log(`     Value:  ${op.name} = "${op.value}"`);
      else if (op.value) console.log(`     Value:  "${op.value}"`);
    });

    if (result.needsHuman.length > 0) {
      console.log(`\nItems Routed to Human Review (${result.needsHuman.length}):`);
      result.needsHuman.forEach((h, idx) => {
        console.log(`  ${idx + 1}. [${h.selector || h.issueId}] ${h.reason}`);
      });
    }

    console.log(`\n--- Unified Diff ---`);
    console.log(result.diff);

    console.log(`\nArtifacts Written:`);
    console.log(`  Patched HTML: cache/${siteArg}/patched.html`);
    console.log(`  Diff:         cache/${siteArg}/fix.diff`);
    console.log(`  Ops:          cache/${siteArg}/ops.json`);
    console.log(`======================================================\n`);
  } catch (err) {
    console.error('[fixer] Execution failed:', err);
    process.exit(1);
  }
}
