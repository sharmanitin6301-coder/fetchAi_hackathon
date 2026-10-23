#!/usr/bin/env node

/**
 * AccessFix Cached Replay Test Runner: demo-sites/fixed.html
 * 
 * Validates that cached run files for fixed.html exist, are internally consistent,
 * and accurately report that an already-accessible page passes with 0 violations
 * and 0 fixes.
 */

import { readStageCache } from '../src/cache.js';
import fs from 'fs';
import path from 'path';

console.log('====================================================================');
console.log(' AccessFix Cached Replay Test Runner');
console.log(' Target: demo-sites/fixed.html');
console.log(' Mode:   Cached Replay');
console.log('====================================================================\n');

try {
  const runJsonPath = path.resolve(process.cwd(), 'cache/fixed/run.json');
  if (!fs.existsSync(runJsonPath)) {
    throw new Error(`Cache file not found at ${runJsonPath}`);
  }

  const runJson = JSON.parse(fs.readFileSync(runJsonPath, 'utf-8'));
  const verification = (await readStageCache('fixed', 'verification'))?.data;

  if (!verification) {
    throw new Error('cache/fixed/verification.json not found or empty.');
  }

  const fixesCount = runJson.metrics.fixesApplied ?? 0;
  const unresolvedHuman = verification.unresolvedHuman?.length || 0;

  console.log('[cachedTest] Loaded cache/fixed/run.json and stage cache files successfully.');
  console.log('\n======================================================');
  console.log(' Cached Verification Results Summary (fixed.html)');
  console.log('======================================================');
  console.log(`Execution Mode:      Cached Replay (Saved Run)`);
  console.log(`Axe Violations:      ${runJson.metrics.axeBefore} before -> ${runJson.metrics.axeAfter} after`);
  console.log(`Blind Agent Before:  ${verification.agentBefore.success ? 'PASSED' : 'FAILED'} (${verification.agentBefore.steps} steps)`);
  console.log(`Blind Agent After:   ${verification.agentAfter.success ? 'PASSED' : 'FAILED'} (${verification.agentAfter.steps} steps)`);
  console.log(`Automated Fixes:     ${fixesCount}`);
  console.log(`Unresolved Human:    ${unresolvedHuman}`);
  console.log('======================================================\n');

  // Assertions for consistency
  if (runJson.metrics.axeBefore !== 0 || runJson.metrics.axeAfter !== 0) {
    throw new Error(`Expected 0 Axe violations on fixed.html, got before=${runJson.metrics.axeBefore}, after=${runJson.metrics.axeAfter}`);
  }
  if (!verification.agentBefore.success || !verification.agentAfter.success) {
    throw new Error(`Expected Blind Agent to succeed on fixed.html, got before=${verification.agentBefore.success}, after=${verification.agentAfter.success}`);
  }
  if (fixesCount !== 0) {
    throw new Error(`Expected 0 fixes on fixed.html, got ${fixesCount}`);
  }

  console.log('✅ CACHED TEST PASSED! All cached metrics are consistent and verified.\n');
  process.exit(0);
} catch (err) {
  console.error(`\n❌ CACHED TEST FAILED: ${err.message}\n`);
  process.exit(1);
}
