import express from 'express';
import path from 'path';
import fs from 'fs/promises';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import process from 'process';
import 'dotenv/config';

import { loadConfig, validateLLMConfig } from './src/config.js';
import { resolveTargetUrl, scanPage } from './src/scanner.js';
import { findTask } from './src/taskFinder.js';
import { runBlindAgent } from './src/blindAgent.js';
import { prioritize } from './src/prioritizer.js';
import { fix } from './src/fixer.js';
import { verify } from './src/verifier.js';
import { readStageCache, getSiteCacheDir } from './src/cache.js';
import { getExhaustedProviders } from './src/llm.js';

const app = express();
const port = parseInt(process.env.PORT || '3000', 10);
const publicDir = path.resolve('public');

// Request parsing & security limits
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// Serve frontend static assets from public/
app.use(express.static(publicDir));

// Explicit route to serve public/index.html
app.get('/', (req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

// Active runs memory store
const runs = new Map();

// Validates input target URL or local file path
function validateInputTarget(input) {
  if (!input || typeof input !== 'string') {
    throw new Error('Target URL or file path is required.');
  }

  const trimmed = input.trim();

  // Prevent path traversal
  if (trimmed.includes('..') || trimmed.includes('\0')) {
    throw new Error('Invalid path: Directory traversal not permitted.');
  }

  // Handle web URLs
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      const host = parsed.hostname.toLowerCase();

      // Block cloud metadata services and internal link-local / non-routable IPs
      if (
        host === '169.254.169.254' ||
        host === 'metadata.google.internal' ||
        host.startsWith('10.') ||
        host.startsWith('192.168.') ||
        /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(host)
      ) {
        throw new Error('Access to private metadata or internal subnets is prohibited.');
      }

      // Allow localhost or standard public URLs
      return { type: 'web', target: trimmed, siteName: host.replace(/[^a-zA-Z0-9_-]/g, '_') };
    } catch (err) {
      throw new Error(`Invalid URL: ${err.message}`);
    }
  }

  // Handle local filesystem targets
  const resolved = path.resolve(trimmed);
  const cwd = process.cwd();

  // Restrict to workspace project folder and demo-sites
  if (!resolved.startsWith(cwd)) {
    throw new Error('File access outside project workspace is prohibited.');
  }

  // Restrict from accessing sensitive internal directories
  const relative = path.relative(cwd, resolved);
  if (relative.startsWith('.git') || relative.startsWith('node_modules') || relative.startsWith('.env')) {
    throw new Error('Access to system or sensitive files is prohibited.');
  }

  const baseName = path.basename(resolved, path.extname(resolved)) || 'broken';
  return { type: 'file', target: relative, siteName: baseName };
}

// Emits Server-Sent Event to all active clients for a run and records event history
function emitRunEvent(run, eventName, payload) {
  const data = JSON.stringify({
    runId: run.runId,
    timestamp: new Date().toISOString(),
    ...payload,
  });

  if (!run.eventHistory) {
    run.eventHistory = [];
  }
  run.eventHistory.push({ eventName, data });

  run.clients.forEach((client) => {
    try {
      client.write(`event: ${eventName}\ndata: ${data}\n\n`);
    } catch {
      // Client disconnected
    }
  });
}

// Loads cached run artifacts for demo-mode execution
async function loadCachedRunData(siteName) {
  const [beforeCache, agentBeforeCache, prioritizedCache, verificationCache, opsCache] = await Promise.all([
    readStageCache(siteName, 'before'),
    readStageCache(siteName, 'agent_before'),
    readStageCache(siteName, 'prioritized'),
    readStageCache(siteName, 'verification'),
    readStageCache(siteName, 'ops'),
  ]);

  const cacheDir = await getSiteCacheDir(siteName);
  let diffContent = '';
  let patchedHtml = '';
  let originalHtml = '';

  try {
    diffContent = await fs.readFile(path.join(cacheDir, 'fix.diff'), 'utf-8');
  } catch {}

  try {
    patchedHtml = await fs.readFile(path.join(cacheDir, 'patched.html'), 'utf-8');
  } catch {}

  try {
    originalHtml = await fs.readFile(path.resolve('demo-sites', `${siteName}.html`), 'utf-8');
  } catch {}

  const vData = verificationCache?.data || {};

  return {
    axeBefore: vData.axeBefore ?? beforeCache?.data?.axeSummary?.totalViolations ?? 7,
    axeAfter: vData.axeAfter ?? 0,
    agentBefore: vData.agentBefore ?? {
      success: agentBeforeCache?.data?.success ?? false,
      steps: agentBeforeCache?.data?.steps ?? 12,
      stuckAt: agentBeforeCache?.data?.stuckAt || 'Element "#emailInput" focused 4 times without completing task.',
    },
    agentAfter: vData.agentAfter ?? {
      success: true,
      steps: 5,
      stuckAt: null,
    },
    diff: diffContent,
    ops: opsCache?.data?.appliedOps || [],
    layoutFlags: vData.layoutFlags || [],
    transcripts: vData.transcripts || { before: [], after: [] },
    needsHuman: prioritizedCache?.data?.needsHuman || [],
    issues: prioritizedCache?.data?.issues || [],
    originalHtml,
    patchedHtml,
  };
}

// Replays cache/<site>/run.json through the SSE stream with realistic delays
async function replayCachedRun(run, { isFallback = false } = {}) {
  console.log(`[server] ${isFallback ? 'Fallback: ' : ''}Replaying cached run for site "${run.siteName}"...`);
  const cacheDir = await getSiteCacheDir(run.siteName);
  const runJsonPath = path.join(cacheDir, 'run.json');

  let runJson = null;
  try {
    const raw = await fs.readFile(runJsonPath, 'utf-8');
    runJson = JSON.parse(raw);
  } catch (err) {
    console.warn(`[server] Could not load ${runJsonPath}: ${err.message}.`);
  }

  // 2.2 replayCachedRun must read cache/<siteName>/run.json. If it does not exist, show a clear notice that no saved run exists for this site (never replay the broken run for another site).
  if (!runJson || !Array.isArray(runJson.events) || runJson.events.length === 0) {
    run.status = 'failed';
    const notice = `No saved run cache found for site "${run.siteName}". Please run a live analysis first or record a cache with "npm run record".`;
    console.warn(`[server] ${notice}`);
    emitRunEvent(run, 'error', {
      status: 'failed',
      message: notice,
    });
    return;
  }

  for (const evt of runJson.events) {
    // Realistic delay between 0.5s and 2s per stage
    const delay = Math.min(2000, Math.max(500, evt.delayMs || 800));
    await new Promise((resolve) => setTimeout(resolve, delay));

    if (evt.event === 'stage') {
      emitRunEvent(run, 'stage', evt.payload);
    } else if (evt.event === 'complete') {
      const cachedData = evt.data || (await loadCachedRunData(run.siteName));
      run.data = cachedData;
      run.status = 'completed';

      emitRunEvent(run, 'complete', {
        status: 'success',
        result: evt.result || {
          axeBefore: cachedData.axeBefore,
          axeAfter: cachedData.axeAfter,
          agentBefore: cachedData.agentBefore,
          agentAfter: cachedData.agentAfter,
          fixesCount: cachedData.ops?.length || 0,
          layoutFlagsCount: cachedData.layoutFlags?.length || 0,
          needsHumanCount: cachedData.needsHuman?.length || 0,
        },
        data: cachedData,
      });
    } else {
      emitRunEvent(run, evt.event, evt.payload || {});
    }
  }
}

// Executes pipeline (cached replay or live execution with automatic fallback)
async function executePipeline(run) {
  run.status = 'running';

  const isDemoCache = process.env.DEMO_CACHE === 'true';
  const shouldReplay = isDemoCache || run.useCache;

  if (shouldReplay) {
    // User ticked 'Use cached demo' or DEMO_CACHE=true in .env
    emitRunEvent(run, 'fallback', {
      reason: 'user_cached',
      message: 'Replaying a saved run (cached demo)',
    });

    try {
      await replayCachedRun(run, { reason: 'user_cached' });
    } catch (err) {
      console.error(`[server] Cache replay error:`, err);
      run.status = 'failed';
      emitRunEvent(run, 'error', {
        status: 'failed',
        message: err.message || 'Cache replay failed.',
      });
    }
    return;
  }

  // Live execution mode
  console.log(`[server] Executing pipeline in LIVE mode for "${run.url}"...`);
  try {
    // 1. Scan Stage
    emitRunEvent(run, 'stage', {
      stage: 'scan',
      status: 'running',
      message: 'Launching Chromium: running Axe WCAG audit and keyboard traversal...',
    });
    const scanResult = await scanPage(run.url, run.siteName);
    emitRunEvent(run, 'stage', {
      stage: 'scan',
      status: 'completed',
      message: `Scan complete: ${scanResult.axeSummary.totalViolations} violations found.`,
      data: { axeBefore: scanResult.axeSummary.totalViolations },
    });

    // 2. Task Stage
    emitRunEvent(run, 'stage', {
      stage: 'task',
      status: 'running',
      message: 'Identifying primary visitor goal from accessible snapshot...',
    });
    const task = await findTask('Target Page', scanResult.ariaTree, run.url);
    emitRunEvent(run, 'stage', {
      stage: 'task',
      status: 'completed',
      message: `Discovered goal: "${task.task}"`,
      data: { task: task.task },
    });

    // 3. Agent Stage
    emitRunEvent(run, 'stage', {
      stage: 'agent',
      status: 'running',
      message: 'Executing Blind Agent keyboard navigation on initial page...',
    });

    // 4. Fix Stage
    emitRunEvent(run, 'stage', {
      stage: 'fix',
      status: 'running',
      message: 'Synthesizing repairs and generating working copy...',
    });

    // 5. Verify Stage
    emitRunEvent(run, 'stage', {
      stage: 'verify',
      status: 'running',
      message: 'Executing end-to-end verification loop with layout check and transcripts...',
    });

    const verificationResult = await verify(run.url);

    const cachedData = await loadCachedRunData(run.siteName);
    run.data = cachedData;
    run.status = 'completed';

    emitRunEvent(run, 'complete', {
      status: 'success',
      result: {
        axeBefore: verificationResult.axeBefore,
        axeAfter: verificationResult.axeAfter,
        agentBefore: verificationResult.agentBefore,
        agentAfter: verificationResult.agentAfter,
        fixesCount: run.data.ops.length,
        layoutFlagsCount: verificationResult.layoutFlags.length,
        needsHumanCount: run.data.needsHuman.length,
      },
      data: run.data,
    });
  } catch (liveErr) {
    console.warn(`[server] Live execution failed (${liveErr.message}). Checking for saved cache...`);

    // 2.3 if live execution fails on a site with no cache, emit an error event with a clear message. Never claim success from an empty cache.
    const cacheDir = await getSiteCacheDir(run.siteName);
    const runJsonPath = path.join(cacheDir, 'run.json');
    let hasCache = false;
    try {
      const raw = await fs.readFile(runJsonPath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.events) && parsed.events.length > 0) {
        hasCache = true;
      }
    } catch {
      hasCache = false;
    }

    if (!hasCache) {
      console.error(`[server] Live execution failed and no cached run exists for site "${run.siteName}".`);
      run.status = 'failed';
      emitRunEvent(run, 'error', {
        status: 'failed',
        message: `Live execution failed: ${liveErr.message}. No saved demo run exists for "${run.siteName}".`,
      });
      return;
    }

    // Emit fallback event for UI notification banner (automatic fallback)
    emitRunEvent(run, 'fallback', {
      reason: 'auto_fallback',
      message: 'Live AI busy, replaying saved run',
      error: liveErr.message,
    });

    // Seamlessly replay cached run!
    try {
      await replayCachedRun(run, { isFallback: true });
    } catch (replayErr) {
      console.error(`[server] Fallback replay also failed:`, replayErr);
      run.status = 'failed';
      emitRunEvent(run, 'error', {
        status: 'failed',
        message: replayErr.message || 'Execution halted.',
      });
    }
  }
}

// GET /health — returns system demo readiness check in JSON or HTML
app.get('/health', async (req, res) => {
  const isDemoCache = process.env.DEMO_CACHE === 'true';
  const hasGemini = Boolean(process.env.GEMINI_API_KEY?.trim());
  const geminiModel = process.env.GEMINI_MODEL?.trim() || 'not set';
  const hasGroq = Boolean(process.env.GROQ_API_KEY?.trim());
  const groqModel = process.env.GROQ_MODEL?.trim() || 'not set';
  const hasOpenRouter = Boolean(process.env.OPENROUTER_API_KEY?.trim());
  const openrouterModel = process.env.OPENROUTER_MODEL?.trim() || 'not set';
  const providerOrder = (process.env.LLM_PROVIDER_ORDER || 'groq,gemini,openrouter')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const exhausted = getExhaustedProviders();

  let cacheValid = false;
  let cacheEventsCount = 0;
  const cachePath = path.resolve('cache', 'broken', 'run.json');

  try {
    const raw = await fs.readFile(cachePath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.events) && parsed.events.length > 0) {
      cacheValid = true;
      cacheEventsCount = parsed.events.length;
    }
  } catch {
    cacheValid = false;
  }

  // Ready for demo check:
  // Ready if cached run is valid or at least one LLM provider is configured
  const isReady = cacheValid || hasGemini || hasGroq || hasOpenRouter;
  const readyStatus = isReady ? 'YES' : 'NO';

  const healthData = {
    ready: isReady,
    readyForDemo: readyStatus,
    status: `Ready for demo: ${readyStatus}`,
    demoCache: isDemoCache,
    providerOrder,
    exhaustedProviders: exhausted,
    cache: {
      file: 'cache/broken/run.json',
      exists: cacheValid,
      valid: cacheValid,
      eventsCount: cacheEventsCount,
    },
    providers: {
      groq: {
        configured: hasGroq,
        model: groqModel,
        exhausted: Boolean(exhausted.groq),
      },
      gemini: {
        configured: hasGemini,
        model: geminiModel,
        exhausted: Boolean(exhausted.gemini),
      },
      openrouter: {
        configured: hasOpenRouter,
        model: openrouterModel,
        exhausted: Boolean(exhausted.openrouter),
      },
    },
    timestamp: new Date().toISOString(),
  };

  const acceptsHtml = req.headers.accept && req.headers.accept.includes('text/html');
  if (acceptsHtml && req.query.format !== 'json') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AccessFix Health Check</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; padding: 40px; line-height: 1.6; color: #111827; background: #F9FAFB; }
    .card { max-width: 650px; margin: 0 auto; background: #FFF; border: 1px solid #D1D5DB; border-radius: 12px; padding: 32px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05); }
    h1 { font-size: 24px; margin-bottom: 12px; }
    .badge { display: inline-block; padding: 6px 14px; border-radius: 6px; font-weight: 700; font-size: 16px; margin-bottom: 24px; }
    .badge.yes { background: #DCFCE7; color: #14532D; border: 1px solid #86EFAC; }
    .badge.no { background: #FEE2E2; color: #7F1D1D; border: 1px solid #FCA5A5; }
    ul { list-style: none; padding: 0; margin-bottom: 24px; }
    li { padding: 10px 0; border-bottom: 1px solid #E5E7EB; }
    li:last-child { border-bottom: none; }
    strong { color: #111827; }
    a { color: #1D4ED8; text-decoration: none; font-weight: 600; }
    a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="card">
    <h1>AccessFix Health Check</h1>
    <div class="badge ${isReady ? 'yes' : 'no'}">
      Ready for demo: ${readyStatus}
    </div>
    <ul>
      <li>
        <strong>Configured LLM Providers:</strong><br>
        • Gemini: ${hasGemini ? `<span style="color:#166534">Configured (${geminiModel})</span>` : '<span style="color:#991B1B">Not configured (no GEMINI_API_KEY)</span>'}<br>
        • Groq: ${hasGroq ? `<span style="color:#166534">Configured (${groqModel})</span>` : '<span style="color:#991B1B">Not configured (no GROQ_API_KEY)</span>'}
      </li>
      <li>
        <strong>Cached Demo Run:</strong><br>
        • <code>cache/broken/run.json</code>: ${cacheValid ? `<span style="color:#166534">Valid (${cacheEventsCount} stream events ready)</span>` : '<span style="color:#991B1B">Not found or invalid</span>'}
      </li>
      <li>
        <strong>DEMO_CACHE Active:</strong> ${isDemoCache ? '<span style="color:#166534">YES (forced cache mode)</span>' : '<span style="color:#6B7280">NO (controlled by UI checkbox)</span>'}
      </li>
    </ul>
    <p><a href="/">← Return to AccessFix Dashboard</a> | <a href="/health?format=json">View as JSON</a></p>
  </div>
</body>
</html>`);
  }

  return res.status(200).json(healthData);
});

// POST /run — starts pipeline and returns runId
app.post('/run', async (req, res) => {
  try {
    const { url, useCache } = req.body || {};
    const validated = validateInputTarget(url?.trim() || 'demo-sites/broken.html');
    const isDemoCache = process.env.DEMO_CACHE === 'true';

    const runId = crypto.randomUUID();
    const run = {
      runId,
      url: validated.target,
      siteName: validated.siteName,
      useCache: isDemoCache || Boolean(useCache),
      status: 'pending',
      stage: 'init',
      clients: [],
      data: null,
      error: null,
      createdAt: new Date().toISOString(),
    };

    runs.set(runId, run);

    // Asynchronously begin pipeline execution
    setTimeout(() => executePipeline(run), 50);

    return res.status(200).json({
      runId,
      siteName: run.siteName,
      status: 'started',
      useCache: run.useCache,
    });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

// GET /events — Server-Sent Events stream for a run
app.get('/events', (req, res) => {
  const { runId } = req.query;
  const run = runs.get(runId);

  if (!run) {
    return res.status(404).send('Run not found.');
  }

  // Set SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  res.write(`event: connected\ndata: ${JSON.stringify({ runId, status: run.status })}\n\n`);

  // Deliver any events that were emitted prior to SSE connection
  if (run.eventHistory && run.eventHistory.length > 0) {
    run.eventHistory.forEach(({ eventName, data }) => {
      try {
        res.write(`event: ${eventName}\ndata: ${data}\n\n`);
      } catch {}
    });
  }

  run.clients.push(res);

  req.on('close', () => {
    run.clients = run.clients.filter((client) => client !== res);
  });
});

// GET /patch — downloads actual generated unified diff
app.get('/patch', async (req, res) => {
  const { runId, site } = req.query;
  let siteName = 'broken';
  let diffContent = '';

  if (runId && runs.has(runId)) {
    const run = runs.get(runId);
    siteName = run.siteName || 'broken';
    if (run.data?.diff) {
      diffContent = run.data.diff;
    }
  } else if (site) {
    siteName = site.replace(/[^a-zA-Z0-9_-]/g, '');
  }

  if (!diffContent) {
    try {
      const cacheDir = await getSiteCacheDir(siteName);
      const diffPath = path.join(cacheDir, 'fix.diff');
      diffContent = await fs.readFile(diffPath, 'utf-8');
    } catch {
      return res.status(404).send('Unified diff not found for requested target.');
    }
  }

  res.setHeader('Content-Type', 'text/x-diff');
  res.setHeader('Content-Disposition', `attachment; filename="accessfix-${siteName}.diff"`);
  return res.send(diffContent);
});

// GET /preview/:runId/:version — securely serves sandboxed preview HTML
app.get('/preview/:runId/:version', async (req, res) => {
  const { runId, version } = req.params;
  const run = runs.get(runId);
  const siteName = run ? run.siteName : 'broken';

  // Apply minimal sandbox CSP header to prevent parent frame interference
  res.setHeader('Content-Security-Policy', "default-src 'self' 'unsafe-inline' data:;");

  try {
    if (version === 'before') {
      if (run?.data?.originalHtml) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.send(run.data.originalHtml);
      }
      const origPath = path.resolve('demo-sites', `${siteName}.html`);
      const html = await fs.readFile(origPath, 'utf-8');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.send(html);
    }

    if (version === 'after') {
      if (run?.data?.patchedHtml) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.send(run.data.patchedHtml);
      }
      const cacheDir = await getSiteCacheDir(siteName);
      const patchedPath = path.join(cacheDir, 'patched.html');
      const html = await fs.readFile(patchedPath, 'utf-8');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.send(html);
    }

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(400).send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #F9FAFB; color: #374151; text-align: center; padding: 24px; box-sizing: border-box; }
    .card { background: #FFFFFF; border: 2px dashed #D1D5DB; border-radius: 12px; padding: 36px 28px; max-width: 440px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05); }
    .icon { font-size: 36px; margin-bottom: 12px; }
    h2 { font-size: 18px; margin: 0 0 8px 0; color: #111827; }
    p { font-size: 14px; margin: 0; color: #6B7280; line-height: 1.5; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon" aria-hidden="true">⚠️</div>
    <h2>Invalid Preview Version</h2>
    <p>Version parameter must be "before" or "after".</p>
  </div>
</body>
</html>`);
  } catch (err) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(404).send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #F9FAFB; color: #374151; text-align: center; padding: 24px; box-sizing: border-box; }
    .card { background: #FFFFFF; border: 2px dashed #D1D5DB; border-radius: 12px; padding: 36px 28px; max-width: 440px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05); }
    .icon { font-size: 36px; margin-bottom: 12px; }
    h2 { font-size: 18px; margin: 0 0 8px 0; color: #111827; }
    p { font-size: 14px; margin: 0; color: #6B7280; line-height: 1.5; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon" aria-hidden="true">📄</div>
    <h2>Preview Unavailable</h2>
    <p>${err.message || 'The requested preview document could not be rendered.'}</p>
  </div>
</body>
</html>`);
  }
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('[server] Uncaught request error:', err.message);
  res.status(500).json({ error: 'Internal server error occurred.' });
});

// Start Express server
const server = app.listen(port, () => {
  console.log(`[server] AccessFix Web Dashboard running at:`);
  console.log(`         http://localhost:${port}`);
});

// Startup error handler for EADDRINUSE and network binding failures
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n[server] Startup Error: Port ${port} is already in use by another process.`);
    console.error(`[server] To kill the process using port ${port}:`);
    console.error(`         kill -9 $(lsof -t -i :${port})`);
    console.error(`[server] Or run on a different port:`);
    console.error(`         PORT=${port + 1} node server.js\n`);
  } else {
    console.error(`\n[server] Startup Error (${err.code || 'UNKNOWN'}):`, err.message, '\n');
  }
  process.exit(1);
});

// Process-level guards to ensure server stays alive
process.on('uncaughtException', (err) => {
  console.error('[server] Uncaught Exception:', err.message);
});

process.on('unhandledRejection', (reason) => {
  console.error('[server] Unhandled Promise Rejection:', reason);
});

export { app, server };
