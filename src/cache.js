import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import process from 'process';

// Sanitizes site URL or name to safe filesystem folder name
export async function sanitizeSiteName(site) {
  return site
    .replace(/^https?:\/\//, '')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/^_+|_+$/g, '') || 'default';
}

// Resolves site cache directory and ensures it exists on disk
export async function getSiteCacheDir(site) {
  const safeName = await sanitizeSiteName(site);
  const cacheDir = path.resolve('cache', safeName);
  await fs.mkdir(cacheDir, { recursive: true });
  return cacheDir;
}

// Saves a stage output payload to cache/<site>/<stage>.json
export async function saveStageCache(site, stage, data) {
  const dir = await getSiteCacheDir(site);
  const filePath = path.join(dir, `${stage}.json`);
  const payload = {
    site,
    stage,
    timestamp: new Date().toISOString(),
    data,
  };
  await fs.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf-8');
  return filePath;
}

// Reads and parses a stage output payload from cache/<site>/<stage>.json
export async function readStageCache(site, stage) {
  const dir = await getSiteCacheDir(site);
  const filePath = path.join(dir, `${stage}.json`);
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') {
      return null;
    }
    throw err;
  }
}

// Lists all stage files currently saved for a site
export async function listStageCache(site) {
  const dir = await getSiteCacheDir(site);
  try {
    const entries = await fs.readdir(dir);
    return entries.filter((name) => name.endsWith('.json')).map((name) => name.replace(/\.json$/, ''));
  } catch (err) {
    if (err.code === 'ENOENT') {
      return [];
    }
    throw err;
  }
}

// CLI test runner
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const testSite = 'https://example.com/test';
  const stage = 'smoke-test';
  const testData = { message: 'Cache subsystem operational', ok: true };

  const savedPath = await saveStageCache(testSite, stage, testData);
  console.log(`[cache] Saved test stage to: ${savedPath}`);

  const loaded = await readStageCache(testSite, stage);
  console.log(`[cache] Read test stage verified:`, loaded?.data?.ok === true ? 'PASSED' : 'FAILED');

  const stages = await listStageCache(testSite);
  console.log(`[cache] Stages found for site:`, stages);
}
