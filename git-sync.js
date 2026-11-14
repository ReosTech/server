#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');

// ==============================================================================
// git-sync.js
// 1. Pulls the latest files from GitHub on Render startup/restart
// 2. Watches for created/modified/deleted files and pushes them to GitHub
// 3. Starts and manages your server process
//
// Render Start Command:
//   node git-sync.js
// ==============================================================================

// Set your server start command here (or via the SERVER_CMD env var in Render)
// Examples: "npm start", "node server.js", "gunicorn app:app --bind 0.0.0.0:$PORT"
const CONFIG_SERVER_CMD = '';

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_REPO = process.env.GITHUB_REPO || '';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';
const SYNC_PATH = process.env.SYNC_PATH || '.';
const SYNC_INTERVAL_MS = (Number(process.env.SYNC_INTERVAL) || 5) * 1000;
const GIT_USER_NAME = process.env.GIT_USER_NAME || 'Render Sync Bot';
const GIT_USER_EMAIL = process.env.GIT_USER_EMAIL || 'render-sync@users.noreply.github.com';

const isWin = process.platform === 'win32';

// Prevent accidental infinite recursion if package.json "start" calls git-sync.js
if (process.env.GIT_SYNC_ACTIVE === '1') {
  console.error('[git-sync] ERROR: Recursive launch detected. Set SERVER_CMD to your actual server file (e.g. "node server.js").');
  process.exit(1);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveServerCmd(cliArgs) {
  if (cliArgs.length > 0) {
    return { cmd: cliArgs[0], args: cliArgs.slice(1), shell: false };
  }

  const envOrConfigCmd = (process.env.SERVER_CMD || CONFIG_SERVER_CMD || '').trim();
  if (envOrConfigCmd) {
    return { cmd: envOrConfigCmd, args: [], shell: true };
  }

  if (fs.existsSync('package.json')) {
    try {
      const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
      const startScript = pkg?.scripts?.start || '';
      if (startScript && !startScript.includes('git-sync')) {
        return { cmd: 'npm start', args: [], shell: true };
      }
      if (pkg?.main && fs.existsSync(pkg.main) && !pkg.main.includes('git-sync')) {
        return { cmd: `node "${pkg.main}"`, args: [], shell: true };
      }
    } catch {
      // Fall through to file detection
    }
  }

  if (fs.existsSync('server.js')) return { cmd: 'node server.js', args: [], shell: true };
  if (fs.existsSync('index.js')) return { cmd: 'node index.js', args: [], shell: true };
  if (fs.existsSync('app.py')) return { cmd: 'python3 app.py', args: [], shell: true };
  if (fs.existsSync('main.py')) return { cmd: 'python3 main.py', args: [], shell: true };

  console.error('[git-sync] ERROR: Could not determine server command.');
  console.error('[git-sync] Set SERVER_CMD in Render Environment Variables or CONFIG_SERVER_CMD in git-sync.js.');
  process.exit(1);
}

function spawnServer(target) {
  const display = target.shell ? target.cmd : [target.cmd, ...target.args].join(' ');
  console.log(`[git-sync] Starting server: ${display}`);

  const childEnv = { ...process.env, GIT_SYNC_ACTIVE: '1' };

  return spawn(target.cmd, target.args, {
    shell: target.shell,
    stdio: 'inherit',
    env: childEnv,
    detached: !isWin,
  });
}

function killServer(serverProc, signal = 'SIGTERM') {
  if (!serverProc || serverProc.killed || serverProc.exitCode !== null) return;
  try {
    if (!isWin && serverProc.pid) {
      // Kill entire process group so shell + child processes exit cleanly
      process.kill(-serverProc.pid, signal);
    } else {
      serverProc.kill(signal);
    }
  } catch {
    try {
      serverProc.kill(signal);
    } catch {
      // Ignore if already exited
    }
  }
}

function createAskpassScript() {
  const filePath = path.join(
    os.tmpdir(),
    `git-askpass-${process.pid}-${Date.now()}${isWin ? '.cmd' : '.sh'}`
  );

  const content = isWin
    ? `@echo off\r\necho %~1 | findstr /i "username" >nul && (echo x-access-token) || (echo %GITHUB_TOKEN%)\r\n`
    : `#!/bin/sh\ncase "$1" in\n  *Username*|*username*) printf '%s\\n' "x-access-token" ;;\n  *) printf '%s\\n' "$GITHUB_TOKEN" ;;\nesac\n`;

  fs.writeFileSync(filePath, content, { mode: 0o700 });
  if (!isWin) {
    fs.chmodSync(filePath, 0o700);
  }
  return filePath;
}

function createGitRunner(askpassPath) {
  const gitEnv = {
    ...process.env,
    GIT_ASKPASS: askpassPath,
    GIT_TERMINAL_PROMPT: '0',
  };

  return function runGit(args, { allowFailure = false } = {}) {
    return new Promise((resolve, reject) => {
      execFile(
        'git',
        args,
        { env: gitEnv, maxBuffer: 10 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err && !allowFailure) {
            const detail = (stderr || err.message || '').trim();
            reject(new Error(`git ${args.join(' ')} failed: ${detail}`));
            return;
          }
          resolve({
            code: err ? err.code || 1 : 0,
            stdout: stdout || '',
            stderr: stderr || '',
          });
        }
      );
    });
  };
}

async function initAndPull(runGit, remoteUrl) {
  if (!fs.existsSync('.git')) {
    console.log('[git-sync] Initializing git repository...');
    await runGit(['init']);
  }

  await runGit(['config', 'user.name', GIT_USER_NAME]);
  await runGit(['config', 'user.email', GIT_USER_EMAIL]);

  const remoteCheck = await runGit(['remote', 'get-url', 'origin'], { allowFailure: true });
  if (remoteCheck.code === 0) {
    await runGit(['remote', 'set-url', 'origin', remoteUrl]);
  } else {
    await runGit(['remote', 'add', 'origin', remoteUrl]);
  }

  console.log(`[git-sync] Pulling latest files from ${GITHUB_REPO} (${GITHUB_BRANCH})...`);
  const branchCheck = await runGit(
    ['ls-remote', '--exit-code', '--heads', 'origin', GITHUB_BRANCH],
    { allowFailure: true }
  );

  if (branchCheck.code === 0) {
    await runGit(['fetch', 'origin', GITHUB_BRANCH]);
    await runGit(['checkout', '-B', GITHUB_BRANCH, `origin/${GITHUB_BRANCH}`, '--force']);
    console.log('[git-sync] Pull complete.');
  } else {
    console.log(`[git-sync] Remote branch '${GITHUB_BRANCH}' not found; creating local branch.`);
    await runGit(['checkout', '-B', GITHUB_BRANCH]);
  }
}

async function syncChanges(runGit) {
  const status = await runGit(['status', '--porcelain', '--', SYNC_PATH], { allowFailure: true });
  if (!status.stdout.trim()) return;

  // Brief debounce so files finish writing before staging
  await sleep(2000);

  await runGit(['add', '-A', '--', SYNC_PATH]);

  const staged = await runGit(['diff', '--cached', '--quiet'], { allowFailure: true });
  if (staged.code === 0) return; // Nothing staged

  const timestamp = new Date().toISOString();
  console.log(`[git-sync] Changes detected (${timestamp}). Committing and pushing...`);

  // [skip render] prevents Render from triggering a redeploy loop
  const commit = await runGit(
    ['commit', '-m', `Auto-sync from Render (${timestamp}) [skip render]`],
    { allowFailure: true }
  );
  if (commit.code !== 0) return;

  const push = await runGit(['push', 'origin', GITHUB_BRANCH], { allowFailure: true });
  if (push.code === 0) {
    console.log('[git-sync] Pushed changes to GitHub.');
    return;
  }

  console.log('[git-sync] Push failed; pulling with rebase and retrying...');
  const rebase = await runGit(['pull', '--rebase', 'origin', GITHUB_BRANCH], { allowFailure: true });
  if (rebase.code === 0) {
    const retry = await runGit(['push', 'origin', GITHUB_BRANCH], { allowFailure: true });
    if (retry.code === 0) {
      console.log('[git-sync] Pushed changes to GitHub.');
      return;
    }
  }
  console.error('[git-sync] WARNING: Push retry failed.');
}

async function main() {
  const cliArgs = process.argv.slice(2);

  // Fallback: if GitHub env vars are missing, still start the server
  if (!GITHUB_TOKEN || !GITHUB_REPO) {
    console.warn('[git-sync] WARNING: GITHUB_TOKEN or GITHUB_REPO not set; starting server without git sync.');
    const target = resolveServerCmd(cliArgs);
    const serverProc = spawnServer(target);
    serverProc.on('exit', (code) => process.exit(code ?? 0));
    process.on('SIGTERM', () => killServer(serverProc, 'SIGTERM'));
    process.on('SIGINT', () => killServer(serverProc, 'SIGINT'));
    return;
  }

  const remoteUrl = /^https?:\/\//i.test(GITHUB_REPO)
    ? GITHUB_REPO
    : `https://github.com/${GITHUB_REPO}.git`;

  const askpassPath = createAskpassScript();
  const runGit = createGitRunner(askpassPath);

  const cleanupAskpass = () => {
    try {
      fs.rmSync(askpassPath, { force: true });
    } catch {
      // Ignore cleanup errors
    }
  };

  // 1. Pull latest files before starting the server
  try {
    await initAndPull(runGit, remoteUrl);
  } catch (err) {
    console.error('[git-sync] ERROR during initial pull:', err.message);
    cleanupAskpass();
    process.exit(1);
  }

  // 2. Resolve and launch the server
  const target = resolveServerCmd(cliArgs);
  const serverProc = spawnServer(target);

  let isShuttingDown = false;
  let loopTimer = null;
  let activeSync = null;

  const runSafeSync = async () => {
    if (activeSync) {
      await activeSync;
    }
    activeSync = syncChanges(runGit)
      .catch((err) => console.error('[git-sync] Sync error:', err.message))
      .finally(() => {
        activeSync = null;
      });
    return activeSync;
  };

  // 3. Start background watch loop
  console.log(`[git-sync] Watching '${SYNC_PATH}' every ${SYNC_INTERVAL_MS / 1000}s...`);
  const scheduleNextSync = () => {
    if (isShuttingDown) return;
    loopTimer = setTimeout(async () => {
      if (isShuttingDown) return;
      await runSafeSync();
      scheduleNextSync();
    }, SYNC_INTERVAL_MS);
  };
  scheduleNextSync();

  const waitForServerExit = () =>
    new Promise((resolve) => {
      if (serverProc.exitCode !== null) {
        resolve(serverProc.exitCode);
        return;
      }
      serverProc.once('exit', (code) => resolve(code ?? 0));
      setTimeout(() => {
        killServer(serverProc, 'SIGKILL');
        resolve(1);
      }, 8000).unref();
    });

  const shutdown = async (signal, exitCodeOverride = null) => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    if (loopTimer) clearTimeout(loopTimer);

    if (signal) {
      console.log(`[git-sync] ${signal} received. Stopping server and running final sync...`);
      killServer(serverProc, signal);
    }

    const serverExitCode = exitCodeOverride !== null
      ? exitCodeOverride
      : await waitForServerExit();

    await runSafeSync();
    cleanupAskpass();
    process.exit(signal ? 0 : serverExitCode);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  serverProc.on('exit', (code) => {
    if (!isShuttingDown) {
      shutdown(null, code ?? 0);
    }
  });
}

main();