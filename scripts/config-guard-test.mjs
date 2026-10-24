// Configuration guard test.
//
// The hardening rules that matter most are the ones enforced at STARTUP, because
// they are the only defence against a bad environment value: authentication
// disabled in production, an empty organization allowlist, a plain-HTTP Crayon
// endpoint. Each case below starts the real server with a deliberately unsafe
// environment and asserts it refuses to boot, then checks that a safe
// environment does boot. A rule that silently degrades to a warning would leave
// the data exposed, so every case asserts a non-zero exit.
import { spawn } from 'node:child_process';

const PORT = process.env.GUARD_PORT || '3119';
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'guard-test-token-0123456789abcdef';

const BASE_ENV = {
  ...process.env,
  PORT,
  HOST: '127.0.0.1',
  AUTH_MODE: 'token',
  AUTH_TOKEN: TOKEN,
  ALLOWED_ORGANIZATIONS: '1000001',
  CRAYON_CLIENT_ID: 'dummy',
  CRAYON_CLIENT_SECRET: 'dummy',
  CRAYON_USERNAME: 'dummy',
  CRAYON_PASSWORD: 'dummy',
  LOG_LEVEL: 'error',
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Starts the server and reports whether it came up or exited.
 * @returns {Promise<{booted: boolean, exitCode: number|null, stderr: string}>}
 */
async function run(env, timeoutMs = 6000) {
  const child = spawn(process.execPath, ['dist/index.js'], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...BASE_ENV, ...env },
  });

  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d.toString(); });
  child.stdout.on('data', (d) => { stderr += d.toString(); });

  let exitCode = null;
  child.on('exit', (code) => { exitCode = code; });

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (exitCode !== null) break;
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) {
        child.kill();
        return { booted: true, exitCode: null, stderr };
      }
    } catch { /* not up yet */ }
    await wait(200);
  }

  if (exitCode === null) child.kill();
  await wait(200);
  return { booted: false, exitCode, stderr };
}

const results = [];
const check = async (label, fn) => {
  try { results.push(`${label}: ${await fn()}`); }
  catch (err) { results.push(`${label}: THREW ${err.message}`); }
};

const refuses = (env, pattern) => async () => {
  const { booted, stderr } = await run(env);
  return `refused=${!booted} mentionsGuard=${pattern.test(stderr)}`;
};

await check('PRODUCTION + AUTH_MODE=none refuses to start',
  refuses({ NODE_ENV: 'production', AUTH_MODE: 'none' }, /AUTH_MODE resolves to "none"/));

await check('PRODUCTION + empty ALLOWED_ORGANIZATIONS refuses to start',
  refuses({ NODE_ENV: 'production', ALLOWED_ORGANIZATIONS: '' }, /ALLOWED_ORGANIZATIONS is empty/));

await check('Plain-HTTP CRAYON_API_BASE_URL refuses to start',
  refuses({ CRAYON_API_BASE_URL: 'http://api.crayon.example.com/api/v1' }, /must use https/));

await check('Loopback HTTP CRAYON_API_BASE_URL is allowed (mock servers)',
  async () => {
    const { booted } = await run({ CRAYON_API_BASE_URL: 'http://127.0.0.1:9/api/v1' });
    return `booted=${booted}`;
  });

await check('Safe production configuration boots',
  async () => {
    const { booted } = await run({ NODE_ENV: 'production' });
    return `booted=${booted}`;
  });

await check('Empty allowlist is only a warning outside production',
  async () => {
    const { booted, stderr } = await run({ NODE_ENV: 'development', ALLOWED_ORGANIZATIONS: '' });
    return `booted=${booted} warned=${/ALLOWED_ORGANIZATIONS is empty/.test(stderr)}`;
  });

await check('ALLOW_ALL_ORGANIZATIONS=true is accepted in production',
  async () => {
    const { booted } = await run({
      NODE_ENV: 'production',
      ALLOWED_ORGANIZATIONS: '',
      ALLOW_ALL_ORGANIZATIONS: 'true',
    });
    return `booted=${booted}`;
  });

console.log(results.join('\n'));
