#!/usr/bin/env node

/**
 * AccessFix Live Verification Subprocess Runner
 * 
 * Enforces a strict 120-second timeout, tracks execution phases,
 * captures stdout/stderr, and reports the exact exit code and phase.
 */

import { spawn } from 'child_process';
import path from 'path';
import process from 'process';
import { fileURLToPath } from 'url';

const TIMEOUT_MS = 120000; // 120 seconds
const target = process.argv[2] || 'demo-sites/broken.html';

console.log('====================================================================');
console.log(' AccessFix Live Subprocess Test Runner');
console.log(` Target:  ${target}`);
console.log(` Timeout: ${TIMEOUT_MS / 1000} seconds`);
console.log('====================================================================\n');

let currentPhase = 'initializing';
let stdoutData = '';
let stderrData = '';
let isTimedOut = false;
const startTime = Date.now();

const child = spawn(process.execPath, ['src/verifier.js', target], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    DEMO_CACHE: 'false',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

const timeoutTimer = setTimeout(() => {
  isTimedOut = true;
  console.error(`\n❌ TIMEOUT: Live verification exceeded ${TIMEOUT_MS / 1000} seconds!`);
  console.error(`   Last active phase before timeout: "${currentPhase}"\n`);
  child.kill('SIGTERM');
  setTimeout(() => {
    if (!child.killed) child.kill('SIGKILL');
  }, 3000);
}, TIMEOUT_MS);

child.stdout.on('data', (chunk) => {
  const text = chunk.toString();
  stdoutData += text;
  process.stdout.write(text);

  // Phase tracker heuristics based on verifier stdout
  if (text.includes('Initializing verification pipeline')) {
    currentPhase = 'browser_launch';
  } else if (text.includes('Initial Axe violations:')) {
    currentPhase = 'initial_axe_scan_complete';
  } else if (text.includes('Running Blind Agent on original page')) {
    currentPhase = 'agent_before';
  } else if (text.includes('Agent before status:')) {
    currentPhase = 'agent_before_complete';
  } else if (text.includes('Verification Round')) {
    currentPhase = 'iterative_repair_loop';
  } else if (text.includes('Running Blind Agent on patched working copy')) {
    currentPhase = 'agent_after';
  } else if (text.includes('Generating screen-reader spoken transcripts')) {
    currentPhase = 'transcripts';
  } else if (text.includes('Verification Results Summary')) {
    currentPhase = 'completed';
  }
});

child.stderr.on('data', (chunk) => {
  const text = chunk.toString();
  stderrData += text;
  process.stderr.write(text);
});

child.on('close', (code, signal) => {
  clearTimeout(timeoutTimer);
  const durationSec = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log('\n====================================================================');
  console.log(' Live Subprocess Execution Report');
  console.log('====================================================================');
  console.log(`Duration:       ${durationSec}s`);
  console.log(`Exit Code:      ${code !== null ? code : `Killed by signal ${signal}`}`);
  console.log(`Timed Out:      ${isTimedOut ? 'YES' : 'NO'}`);
  console.log(`Final Phase:    ${currentPhase}`);

  if (isTimedOut) {
    console.error(`\nFailure: Process killed after ${TIMEOUT_MS / 1000}s while in phase "${currentPhase}".`);
    process.exit(124);
  }

  if (code !== 0) {
    console.error(`\nFailure: Process exited with non-zero code ${code} in phase "${currentPhase}".`);
    process.exit(code || 1);
  }

  // Parse stdout to verify that results were genuine
  const hasAxeBefore = /Axe Violations:\s+(\d+)\s+before/.test(stdoutData);
  const hasAgentBefore = /Blind Agent:\s+(PASSED|FAILED)\s+before/.test(stdoutData);
  const hasAgentAfter = /->\s+(PASSED|FAILED)\s+after/.test(stdoutData);

  if (!hasAxeBefore || !hasAgentBefore || !hasAgentAfter) {
    console.error('\nFailure: Process completed without emitting valid verification summary.');
    process.exit(1);
  }

  console.log('\n✅ LIVE TEST PASSED AND VERIFIED WITHIN 120-SECOND TIMEOUT!\n');
  process.exit(0);
});
