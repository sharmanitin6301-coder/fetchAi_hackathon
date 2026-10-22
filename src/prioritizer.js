import path from 'path';
import { fileURLToPath } from 'url';
import process from 'process';
import { readStageCache, saveStageCache } from './cache.js';

// Supported fix types
export const FIX_TYPES = {
  IMAGE_ALT: 'missing image alt (image-alt)',
  BUTTON_NAME: 'button with no accessible name (button-name)',
  INPUT_LABEL: 'form input with no label (label)',
  CONTRAST: 'low text contrast (color-contrast)',
  CLICKABLE_DIV: 'non-focusable clickable div -> real button, with visible focus',
  STRUCTURE: 'page-structure',
};

// Computes score for an accessibility issue based on impact, task blockage, and reachability
export function computeScore({ impact = 'minor', blocksTask = false, isUnreachable = false }) {
  let score = 0;
  if (blocksTask) score += 100;

  switch (impact) {
    case 'critical':
      score += 40;
      break;
    case 'serious':
      score += 30;
      break;
    case 'moderate':
      score += 15;
      break;
    case 'minor':
    default:
      score += 5;
      break;
  }

  // Tie-breaker for unreachable interactive elements
  if (isUnreachable) score += 20;

  return score;
}

// Maps issues to user disability profiles
export function getUserTypes(category) {
  switch (category) {
    case 'contrast':
      return ['low-vision', 'color-blind'];
    case 'keyboard':
      return ['keyboard-only', 'blind'];
    case 'names':
    case 'structure':
    default:
      return ['blind'];
  }
}

// Merges scanner findings and agent failure data into prioritized actionable issues
export async function prioritize(beforeData, agentResult = null) {
  const before = beforeData?.data || beforeData || {};
  const agent = agentResult?.data || agentResult || {};

  const issues = [];
  const needsHuman = [];
  const processedSelectors = new Set();
  const structureViolations = [];

  // 1. Process keyboard-unreachable elements (e.g. non-focusable clickable div)
  const unreachableElements = before.keyboard?.unreachableElements || [];
  for (const el of unreachableElements) {
    const isClickableDiv = el.tag === 'div' && (el.html.includes('onclick') || el.selector.includes('btn') || el.text.toLowerCase().includes('subscribe'));
    const blocksTask = Boolean(!agent.success || (agent.stuckAt && agent.stuckAt.toLowerCase().includes('subscribe')) || el.text.toLowerCase().includes('subscribe'));

    if (isClickableDiv) {
      processedSelectors.add(el.selector);
      issues.push({
        id: `unreachable-${el.selector.replace(/[^a-zA-Z0-9_-]/g, '_')}`,
        fixType: FIX_TYPES.CLICKABLE_DIV,
        selector: el.selector,
        score: computeScore({ impact: 'critical', blocksTask, isUnreachable: true }),
        userTypes: getUserTypes('keyboard'),
        blocksTask,
        reason: `Interactive "${el.text || 'control'}" is a <div> without keyboard focusability (tabindex/role), blocking keyboard navigation.`,
      });
    } else {
      needsHuman.push({
        id: `unreachable-manual-${el.selector.replace(/[^a-zA-Z0-9_-]/g, '_')}`,
        selector: el.selector,
        reason: `Element <${el.tag}> is not reachable via Tab key traversal and requires manual verification.`,
      });
    }
  }

  // 2. Process focused elements without accessible names from keyboard traversal
  const unlabelledElements = before.keyboard?.elementsWithoutAccessibleNames || [];
  for (const el of unlabelledElements) {
    if (processedSelectors.has(el.selector)) continue;

    if (el.tag === 'button' || el.role === 'button') {
      processedSelectors.add(el.selector);
      processedSelectors.add('button');
      issues.push({
        id: `unlabelled-button-${el.selector.replace(/[^a-zA-Z0-9_-]/g, '_')}`,
        fixType: FIX_TYPES.BUTTON_NAME,
        selector: el.selector,
        score: computeScore({ impact: 'critical' }),
        userTypes: getUserTypes('names'),
        blocksTask: false,
        reason: `Button at "${el.selector}" has no accessible name or text for screen reader users.`,
      });
    } else if (el.tag === 'input' || el.role === 'textbox') {
      processedSelectors.add(el.selector);
      processedSelectors.add('input');
      issues.push({
        id: `unlabelled-input-${el.selector.replace(/[^a-zA-Z0-9_-]/g, '_')}`,
        fixType: FIX_TYPES.INPUT_LABEL,
        selector: el.selector,
        score: computeScore({ impact: 'critical' }),
        userTypes: getUserTypes('names'),
        blocksTask: false,
        reason: `Form input "${el.selector}" lacks an associated <label> element.`,
      });
    }
  }

  // 3. Process missing focus indicator on #emailInput
  const missingFocusElements = before.keyboard?.elementsWithoutVisibleFocus || [];
  for (const el of missingFocusElements) {
    if (el.selector === '#emailInput') {
      needsHuman.push({
        id: 'focus-emailInput',
        selector: '#emailInput',
        reason: 'possible false positive, browser default focus ring',
      });
    } else {
      needsHuman.push({
        id: `focus-${el.selector.replace(/[^a-zA-Z0-9_-]/g, '_')}`,
        selector: el.selector,
        reason: 'No visible focus indicator detected on keyboard focus.',
      });
    }
  }

  // 4. Process Axe WCAG violations
  const axeViolations = before.axeViolations || [];
  for (const violation of axeViolations) {
    const targetSelector = violation.nodes?.[0]?.target || '';

    // Collect page structure violations to merge into one composite issue
    if (['heading-order', 'landmark-one-main', 'region', 'html-has-lang'].includes(violation.id)) {
      structureViolations.push({
        ruleId: violation.id,
        selector: targetSelector || 'html',
        impact: violation.impact,
        description: violation.description,
      });
      continue;
    }

    // De-duplicate if selector already mapped to an issue
    if (processedSelectors.has(targetSelector)) continue;

    switch (violation.id) {
      case 'image-alt': {
        processedSelectors.add(targetSelector);
        issues.push({
          id: `axe-image-alt-${targetSelector.replace(/[^a-zA-Z0-9_-]/g, '_') || 'img'}`,
          fixType: FIX_TYPES.IMAGE_ALT,
          selector: targetSelector || 'img',
          score: computeScore({ impact: violation.impact }),
          userTypes: getUserTypes('names'),
          blocksTask: false,
          reason: 'Hero image has no alternative text (alt attribute missing).',
        });
        break;
      }

      case 'button-name': {
        processedSelectors.add(targetSelector);
        issues.push({
          id: `axe-button-name-${targetSelector.replace(/[^a-zA-Z0-9_-]/g, '_') || 'button'}`,
          fixType: FIX_TYPES.BUTTON_NAME,
          selector: targetSelector || 'button',
          score: computeScore({ impact: violation.impact }),
          userTypes: getUserTypes('names'),
          blocksTask: false,
          reason: 'Button does not have discernible text or an aria-label.',
        });
        break;
      }

      case 'label': {
        processedSelectors.add(targetSelector);
        issues.push({
          id: `axe-label-${targetSelector.replace(/[^a-zA-Z0-9_-]/g, '_') || 'input'}`,
          fixType: FIX_TYPES.INPUT_LABEL,
          selector: targetSelector || 'input',
          score: computeScore({ impact: violation.impact }),
          userTypes: getUserTypes('names'),
          blocksTask: false,
          reason: 'Form input does not have a linked <label> element.',
        });
        break;
      }

      case 'color-contrast': {
        processedSelectors.add(targetSelector);
        issues.push({
          id: `axe-contrast-${targetSelector.replace(/[^a-zA-Z0-9_-]/g, '_') || 'text'}`,
          fixType: FIX_TYPES.CONTRAST,
          selector: targetSelector || '.helper-text',
          score: computeScore({ impact: violation.impact }),
          userTypes: getUserTypes('contrast'),
          blocksTask: false,
          reason: 'Text contrast ratio is below the WCAG AA 4.5:1 threshold.',
        });
        break;
      }

      default: {
        needsHuman.push({
          id: `axe-manual-${violation.id}`,
          selector: targetSelector,
          reason: `Axe violation ${violation.id} requires manual audit (${violation.description}).`,
        });
        break;
      }
    }
  }

  // Merge all structure violations into ONE composite issue with fixType "page-structure"
  if (structureViolations.length > 0) {
    const highestScore = Math.max(...structureViolations.map((v) => computeScore({ impact: v.impact })));
    const ruleIds = Array.from(new Set(structureViolations.map((v) => v.ruleId))).join(', ');
    issues.push({
      id: 'page-structure',
      fixType: FIX_TYPES.STRUCTURE,
      selector: 'html',
      score: highestScore,
      userTypes: getUserTypes('structure'),
      blocksTask: false,
      reason: `Page structure issues detected (${ruleIds}): missing landmarks, heading hierarchy, and document language.`,
      details: structureViolations,
    });
  }

  // Sort issues strictly descending by score
  issues.sort((a, b) => b.score - a.score);

  return {
    issues,
    needsHuman,
  };
}

// CLI runner
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const siteArg = process.argv[2] || 'broken';

  console.log(`\n======================================================`);
  console.log(` AccessFix Prioritizer: ${siteArg}`);
  console.log(`======================================================`);

  try {
    const beforeCache = await readStageCache(siteArg, 'before');
    if (!beforeCache) {
      throw new Error(`Cache missing for site "${siteArg}". Run scanner first: node src/scanner.js demo-sites/${siteArg}.html ${siteArg}`);
    }

    const agentCache = await readStageCache(siteArg, 'agent_before');
    const prioritizedResult = await prioritize(beforeCache.data, agentCache?.data || null);

    // Save to cache/<site>/prioritized.json
    await saveStageCache(siteArg, 'prioritized', prioritizedResult);

    console.log(`\nRanked Actionable Issues (${prioritizedResult.issues.length}):`);
    prioritizedResult.issues.forEach((issue, index) => {
      console.log(`\n#${index + 1} [Score: ${issue.score}] ${issue.fixType}`);
      console.log(`   Selector:   ${issue.selector}`);
      console.log(`   Blocks Task: ${issue.blocksTask ? 'YES (+100)' : 'NO'}`);
      console.log(`   User Types: ${issue.userTypes.join(', ')}`);
      console.log(`   Reason:     ${issue.reason}`);
      if (issue.details && issue.details.length > 0) {
        console.log(`   Details (${issue.details.length} sub-rules):`);
        issue.details.forEach((d) => {
          console.log(`     - [${d.ruleId}] ${d.selector}: ${d.description}`);
        });
      }
    });

    console.log(`\nNeeds Human Review (${prioritizedResult.needsHuman.length}):`);
    prioritizedResult.needsHuman.forEach((item, index) => {
      console.log(`  ${index + 1}. [${item.selector}] ${item.reason}`);
    });

    console.log(`\nArtifact saved: cache/${siteArg}/prioritized.json`);
    console.log(`======================================================\n`);
  } catch (err) {
    console.error('[prioritizer] Error:', err.message);
    process.exit(1);
  }
}
