/**
 * Batch Studio Real-Browser Diagnostic & Testing Harness
 *
 * Implements real-browser testing against actual Chrome tabs via Playwright / CDP.
 *
 * Usage:
 *   node scripts/browser-harness.mjs status
 *     -> Checks CDP endpoint and Chrome process status without launching anything.
 *
 *   node scripts/browser-harness.mjs observe
 *     -> Connects to the existing Chrome browser and inspects Google Flow DOM in observation-only mode.
 *
 *   node scripts/browser-harness.mjs launch
 *     -> Starts Chrome detached (isolated test profile) and verifies CDP for 15s.
 *
 *   node scripts/browser-harness.mjs test-run "<prompt text>"
 *     -> Performs a single controlled end-to-end test on the verified Google Flow tab.
 *
 *   node scripts/browser-harness.mjs close
 *     -> Closes ONLY the dedicated test-profile Chrome processes, leaving regular Chrome untouched.
 */

import { chromium } from 'playwright-core';
import fs from 'fs';
import path from 'path';
import http from 'http';
import { execSync } from 'child_process';

const CDP_HOST = '127.0.0.1';
const CDP_PORT = 9222;
const CDP_URL = `http://${CDP_HOST}:${CDP_PORT}`;
const TEST_PROFILE_DIR = 'C:\\Users\\assem\\.gemini\\antigravity\\chrome-test-profile';
const EXTENSION_DIST = path.resolve(process.cwd(), 'dist');

/**
 * Locate Chrome executable across standard Windows installation paths and PATH
 */
export function findChromeExecutable() {
  const candidatePaths = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env['LOCALAPPDATA'] ? path.join(process.env['LOCALAPPDATA'], 'Google', 'Chrome', 'Application', 'chrome.exe') : null,
    process.env['PROGRAMFILES'] ? path.join(process.env['PROGRAMFILES'], 'Google', 'Chrome', 'Application', 'chrome.exe') : null,
    process.env['PROGRAMFILES(X86)'] ? path.join(process.env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe') : null
  ].filter(Boolean);

  for (const p of candidatePaths) {
    if (fs.existsSync(p)) {
      return p;
    }
  }

  // Fallback to where.exe lookup
  try {
    const stdout = execSync('where.exe chrome', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const firstMatch = stdout.split(/\r?\n/)[0]?.trim();
    if (firstMatch && fs.existsSync(firstMatch)) {
      return firstMatch;
    }
  } catch {
    // Ignore where.exe failure
  }

  throw new Error('Google Chrome executable was not found in standard paths or PATH.');
}

/**
 * Bounded timeout helper
 */
export function withTimeout(promise, ms, description = 'Operation') {
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${description} timed out after ${ms}ms`));
    }, ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    clearTimeout(timer);
  });
}

export function isGoogleFlowUrl(urlStr) {
  if (!urlStr || typeof urlStr !== 'string') return false;
  try {
    const url = new URL(urlStr);
    const host = url.hostname.toLowerCase();
    const pathName = url.pathname.toLowerCase();
    if (host === 'flow.google' || host.endsWith('.flow.google')) return true;
    if (host === 'flow.google.com' || host.endsWith('.flow.google.com')) return true;
    if (host === 'labs.google' || host.endsWith('.labs.google')) {
      if (pathName.startsWith('/fx') || pathName.startsWith('/tools/flow') || pathName.startsWith('/flow')) return true;
    }
    if (host === 'aitestkitchen.withgoogle.com') return true;
    return false;
  } catch {
    return false;
  }
}

export function isChatGptUrl(urlStr) {
  if (!urlStr || typeof urlStr !== 'string') return false;
  try {
    const url = new URL(urlStr);
    const host = url.hostname.toLowerCase();
    return host === 'chatgpt.com' || host.endsWith('.chatgpt.com') || host === 'chat.openai.com';
  } catch {
    return false;
  }
}

/**
 * Diagnostic HTTP query to CDP endpoint with bounded timeout
 */
export async function queryCdpEndpoint(endpointPath = '/json/version', timeoutMs = 3000) {
  return new Promise((resolve) => {
    const req = http.get(`http://${CDP_HOST}:${CDP_PORT}${endpointPath}`, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          resolve({
            ok: res.statusCode === 200,
            statusCode: res.statusCode,
            data: res.statusCode === 200 ? JSON.parse(body) : body
          });
        } catch (e) {
          resolve({ ok: false, statusCode: res.statusCode, error: e.message, body });
        }
      });
    });

    req.on('error', (err) => {
      resolve({ ok: false, error: err.message, code: err.code });
    });

    req.setTimeout(timeoutMs, () => {
      req.destroy();
      resolve({ ok: false, error: `Timeout after ${timeoutMs}ms`, code: 'ETIMEDOUT' });
    });
  });
}

/**
 * Inspect running Chrome processes on Windows
 */
export function inspectChromeProcesses() {
  try {
    const stdout = execSync(
      'powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name = \'chrome.exe\'\\" | Select-Object -Property ProcessId, ParentProcessId, CommandLine | ConvertTo-Json -Compress"',
      { timeout: 5000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    );
    if (!stdout.trim()) return [];
    const parsed = JSON.parse(stdout.trim());
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return list.map((p) => {
      const cmd = typeof p.CommandLine === 'string' ? p.CommandLine : '';
      return {
        pid: p.ProcessId,
        parentPid: p.ParentProcessId,
        isTestProfile: cmd.includes('chrome-test-profile'),
        isPort9222: cmd.includes('9222'),
        isUserRegularProfile: !cmd.includes('chrome-test-profile'),
        commandLine: cmd
      };
    });
  } catch (err) {
    return [{ error: `Failed to inspect processes: ${err.message}` }];
  }
}

/**
 * Determine the exact session type currently bound to port 9222
 */
export function determineActiveSessionType(processes, cdpAlive = true) {
  if (!cdpAlive) {
    return {
      type: 'none',
      label: 'No active Chrome instance is listening on port 9222',
      isNormalSession: false,
      isTestSession: false
    };
  }

  const debuggingProc = processes.find((p) => p.isTestProfile) || processes.find((p) => p.isPort9222);
  if (!debuggingProc) {
    return {
      type: 'none',
      label: 'No active Chrome instance is listening on port 9222',
      isNormalSession: false,
      isTestSession: false
    };
  }

  if (debuggingProc.isTestProfile) {
    return {
      type: 'test_profile',
      label: 'Dedicated Isolated Test Profile (C:\\Users\\assem\\.gemini\\antigravity\\chrome-test-profile)',
      isNormalSession: false,
      isTestSession: true,
      pid: debuggingProc.pid
    };
  }

  return {
    type: 'existing_profile',
    label: "User's Existing Normal Chrome Profile (AppData\\Local\\Google\\Chrome\\User Data)",
    isNormalSession: true,
    isTestSession: false,
    pid: debuggingProc.pid
  };
}

/**
 * Poll http://127.0.0.1:9222/json/version for up to maxWaitMs
 */
export async function verifyBrowserReady(expectedPid = null, maxWaitMs = 15000) {
  const start = Date.now();
  console.log(`[Harness] Verifying CDP endpoint at ${CDP_URL} (timeout: ${maxWaitMs / 1000}s)...`);

  while (Date.now() - start < maxWaitMs) {
    const probe = await queryCdpEndpoint('/json/version', 1500);
    if (probe.ok && probe.data && probe.data.webSocketDebuggerUrl) {
      if (expectedPid) {
        const processes = inspectChromeProcesses();
        const found = processes.find((p) => p.pid === expectedPid);
        if (!found) {
          const testProc = processes.find((p) => p.isTestProfile || p.isPort9222);
          if (!testProc) {
            throw new Error(`Chrome process ${expectedPid} exited during verification.`);
          }
        }
      }

      console.log(`[Harness] Browser is READY!`);
      console.log(`  Browser: ${probe.data.Browser}`);
      console.log(`  Protocol: ${probe.data['Protocol-Version']}`);
      console.log(`  CDP WebSocket: ${probe.data.webSocketDebuggerUrl}`);
      return probe.data;
    }
    await new Promise((r) => setTimeout(r, 600));
  }

  throw new Error(`CDP endpoint failed to respond at ${CDP_URL} within ${maxWaitMs / 1000}s.`);
}

/**
 * Launch detached independent Chrome process via WMI to break away from runner Job Object
 */
export async function launchDetachedChrome() {
  const chromePath = findChromeExecutable();
  console.log(`[Harness] Using Chrome executable: ${chromePath}`);
  console.log(`[Harness] Dedicated test profile: ${TEST_PROFILE_DIR}`);
  console.log(`[Harness] Extension path: ${EXTENSION_DIST}`);

  if (!fs.existsSync(EXTENSION_DIST)) {
    throw new Error(`Extension dist directory not found at ${EXTENSION_DIST}. Run 'npm run build' first.`);
  }

  if (!fs.existsSync(TEST_PROFILE_DIR)) {
    fs.mkdirSync(TEST_PROFILE_DIR, { recursive: true });
  }

  // 1. Check if an instance is ALREADY running
  const running = inspectChromeProcesses();
  const existingTestProcs = running.filter((p) => p.isTestProfile);

  if (existingTestProcs.length > 0) {
    console.log(`[Harness] Found ${existingTestProcs.length} existing test Chrome process(es). Checking CDP responsiveness...`);
    const probe = await queryCdpEndpoint('/json/version', 2000);
    if (probe.ok && probe.data?.webSocketDebuggerUrl) {
      console.log(`[Harness] Existing test Chrome (PID ${existingTestProcs[0].pid}) is ALREADY active and responding over CDP.`);
      console.log(`  CDP WebSocket: ${probe.data.webSocketDebuggerUrl}`);
      return { pid: existingTestProcs[0].pid, alreadyRunning: true };
    }
    console.log(`[Harness] Existing test processes found but CDP did not respond. Diagnosing lock...`);
    existingTestProcs.forEach((p) => {
      console.log(`  - PID ${p.pid}: ${p.commandLine.slice(0, 100)}...`);
    });
  }

  // 2. Launch detached Chrome via Windows WMI (Win32_Process.Create)
  console.log('[Harness] Spawning independent detached Chrome via Windows Management Instrumentation (WMI)...');

  const escapedChrome = chromePath.replace(/"/g, '`"');
  const escapedProfile = TEST_PROFILE_DIR.replace(/"/g, '`"');
  const escapedDist = EXTENSION_DIST.replace(/"/g, '`"');

  const wmiCommand = `
    $cmd = '"{0}" --remote-debugging-port=${CDP_PORT} --user-data-dir="{1}" --disable-extensions-except="{2}" --load-extension="{2}" --no-first-run --no-default-browser-check https://flow.google/' -f '${escapedChrome}', '${escapedProfile}', '${escapedDist}'
    $res = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmd }
    if ($res.ReturnValue -ne 0) {
      throw "WMI Win32_Process.Create failed with ReturnValue $($res.ReturnValue)"
    }
    $res.ProcessId
  `.trim();

  let spawnedPid = null;
  try {
    const stdout = execSync(`powershell -NoProfile -Command "${wmiCommand.replace(/\r?\n/g, '; ')}"`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim();
    spawnedPid = parseInt(stdout, 10);
    if (isNaN(spawnedPid)) {
      throw new Error(`Invalid PID returned from WMI: "${stdout}"`);
    }
    console.log(`[Harness] Chrome successfully spawned outside job object (ProcessId: ${spawnedPid}).`);
  } catch (err) {
    console.error(`[Harness] WMI launch failed: ${err.message}. Trying Start-Process fallback...`);
    const fallbackCommand = `
      Start-Process -FilePath '${escapedChrome}' -ArgumentList '--remote-debugging-port=${CDP_PORT}', '--user-data-dir=${escapedProfile}', '--disable-extensions-except=${escapedDist}', '--load-extension=${escapedDist}', '--no-first-run', '--no-default-browser-check', 'https://flow.google/' -PassThru | Select-Object -ExpandProperty Id
    `.trim();
    const stdout = execSync(`powershell -NoProfile -Command "${fallbackCommand.replace(/\r?\n/g, ' ')}"`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim();
    spawnedPid = parseInt(stdout, 10);
    console.log(`[Harness] Start-Process launched Chrome (ProcessId: ${spawnedPid}).`);
  }

  // 3. Verify launch in the same command
  await verifyBrowserReady(spawnedPid, 15000);
  return { pid: spawnedPid, alreadyRunning: false };
}

/**
 * Status command: inspects endpoint and processes without launching anything
 */
export async function showStatus() {
  console.log('\n================ BATCH STUDIO HARNESS STATUS ================');
  console.log(`Target CDP URL: ${CDP_URL}`);

  const probe = await queryCdpEndpoint('/json/version', 2500);
  console.log(`CDP Endpoint Status: ${probe.ok ? 'HEALTHY (HTTP 200)' : `UNREACHABLE (${probe.error || `HTTP ${probe.statusCode}`})`}`);

  const procs = inspectChromeProcesses();
  const sessionInfo = determineActiveSessionType(procs, probe.ok);
  console.log(`Active Connected Session Type: ${sessionInfo.label}`);

  if (probe.ok && probe.data) {
    console.log(`  Browser: ${probe.data.Browser}`);
    console.log(`  Protocol-Version: ${probe.data['Protocol-Version']}`);
    console.log(`  WebSocket URL: ${probe.data.webSocketDebuggerUrl}`);

    const listProbe = await queryCdpEndpoint('/json/list', 2500);
    if (listProbe.ok && Array.isArray(listProbe.data)) {
      console.log(`\nOpen Pages / Targets (${listProbe.data.length} total):`);
      listProbe.data.forEach((t, i) => {
        console.log(`  [${i + 1}] Type: ${t.type.padEnd(14)} | Title: "${t.title.slice(0, 50)}" | URL: ${t.url}`);
      });
    }
  }

  const debuggingProcs = procs.filter((p) => p.isPort9222);
  const regularProcs = procs.filter((p) => p.isUserRegularProfile && !p.isPort9222);

  console.log(`\nChrome Processes Overview:`);
  console.log(`  Processes with port 9222:         ${debuggingProcs.length}`);
  if (debuggingProcs.length > 0) {
    debuggingProcs.forEach((p) => console.log(`    - PID ${p.pid} (${p.isTestProfile ? 'Test Profile' : 'Normal Profile'})`));
  }
  console.log(`  Normal Chrome processes (unattached): ${regularProcs.length}`);
  console.log('=============================================================\n');
}

/**
 * Close command: terminates ONLY the test-profile Chrome processes
 */
export function closeTestBrowser() {
  console.log('\n[Harness] Closing dedicated test-profile Chrome processes...');
  const procs = inspectChromeProcesses();
  const testProcs = procs.filter((p) => p.isTestProfile);

  if (testProcs.length === 0) {
    console.log('[Harness] No dedicated test Chrome processes found running. (User normal Chrome was not touched).');
    return;
  }

  let closedCount = 0;
  for (const p of testProcs) {
    try {
      execSync(`powershell -NoProfile -Command "Stop-Process -Id ${p.pid} -Force -ErrorAction SilentlyContinue"`, { stdio: 'ignore' });
      console.log(`  - Closed test Chrome PID ${p.pid}`);
      closedCount++;
    } catch {
      // Ignore
    }
  }

  console.log(`[Harness] Closed ${closedCount} test process(es). User regular Chrome processes were left untouched.\n`);
}

/**
 * Connect to browser with bounded timeout
 */
export async function connectToBrowser(timeoutMs = 8000) {
  const versionProbe = await queryCdpEndpoint('/json/version', 2500);

  if (!versionProbe.ok) {
    throw new Error(
      `Chrome remote debugging endpoint is not reachable at ${CDP_URL} (Error: ${versionProbe.error || `HTTP ${versionProbe.statusCode}`}).\n` +
      `Make sure Chrome is running with --remote-debugging-port=9222.`
    );
  }

  console.log(`[Harness] Connecting Playwright client to ${CDP_URL}...`);
  return await withTimeout(
    chromium.connectOverCDP(CDP_URL, { timeout: timeoutMs }),
    timeoutMs,
    `Playwright connectOverCDP(${CDP_URL})`
  );
}

/**
 * Safe title fetch with bounded timeout
 */
async function safePageTitle(page, timeoutMs = 2000) {
  try {
    return await withTimeout(page.title(), timeoutMs, 'page.title()');
  } catch {
    return '(title unavailable)';
  }
}

export async function findPlatformPage(browser, platform = 'google_flow') {
  const contexts = browser.contexts();
  for (const ctx of contexts) {
    const pages = ctx.pages();
    for (const page of pages) {
      const url = page.url();
      if (platform === 'google_flow' && isGoogleFlowUrl(url)) {
        return page;
      }
      if (platform === 'chatgpt' && isChatGptUrl(url)) {
        return page;
      }
    }
  }
  return null;
}

/**
 * Observation-Only DOM Inspection (No clicks, no edits, no mutations)
 */
export async function observeFlowPage(page) {
  console.log(`[Harness] Inspecting live page: ${page.url()}`);
  const title = await safePageTitle(page, 2000);
  console.log(`[Harness] Page title: "${title}"`);

  const evaluation = await withTimeout(
    page.evaluate(() => {
      // 1. Content script presence
      const activeRuntimeId =
        document.documentElement.getAttribute('data-batch-studio-connected') ||
        window.__BATCH_STUDIO_ACTIVE_RUNTIME_ID__ ||
        null;

      // 2. Discover prompt composer candidates
      const query = [
        'textarea',
        'div[contenteditable="true"]',
        'p[contenteditable="true"]',
        '[role="textbox"]',
        'input:not([type="hidden"]):not([type="file"]):not([type="checkbox"]):not([type="radio"])'
      ].join(', ');

      const elements = Array.from(document.querySelectorAll(query));
      const composerCandidates = elements.map((el) => {
        const isVisible = el.offsetWidth > 0 || el.offsetHeight > 0 || el.getClientRects().length > 0;
        const isEnabled = !el.disabled;
        const ariaLabel = el.getAttribute('aria-label') || '';
        const placeholder = el.getAttribute('placeholder') || '';
        const role = el.getAttribute('role') || '';
        const tagName = el.tagName.toLowerCase();
        const isContentEditable = el.getAttribute('contenteditable') === 'true' || el.isContentEditable === true;
        const text = el.value || el.textContent || '';
        const id = el.id || '';

        const reasons = [];
        let score = 0;

        if (!isVisible) return { id, tagName, score: -100, rejection: 'Invisible' };
        if (!isEnabled) return { id, tagName, score: -100, rejection: 'Disabled' };

        const lower = `${ariaLabel} ${placeholder}`.toLowerCase();
        if (lower.includes('search') || el.type === 'search' || role === 'searchbox') {
          return { id, tagName, score: -50, rejection: 'Search/filter input' };
        }

        if (tagName === 'textarea' || isContentEditable) {
          score += 40;
          reasons.push(tagName === 'textarea' ? 'Multi-line textarea (+40)' : 'contenteditable (+40)');
        }

        const promptKeywords = ['prompt', 'describe', 'imagine', 'message', 'video', 'image', 'ask'];
        for (const kw of promptKeywords) {
          if (lower.includes(kw)) {
            score += 30;
            reasons.push(`Prompt keyword "${kw}" (+30)`);
            break;
          }
        }

        const container = el.closest('form, [data-testid*="composer"], footer, .composer, [role="region"], div[class*="prompt"], div[class*="dock"], div[class*="bottom"]');
        if (container) {
          score += 25;
          reasons.push('Inside composer/dock container (+25)');
        }

        return {
          id,
          tagName,
          ariaLabel,
          placeholder,
          score,
          currentText: text.slice(0, 50),
          reasons
        };
      }).sort((a, b) => b.score - a.score);

      // 3. Discover submit control candidates
      const buttons = Array.from(document.querySelectorAll('button, [role="button"], input[type="submit"]'));
      const topComposer = composerCandidates.length > 0 && composerCandidates[0].score > 0 ? composerCandidates[0] : null;

      const bestComposerEl = topComposer
        ? elements.find((el) => (topComposer.id && el.id === topComposer.id) || (el.getAttribute('placeholder') && el.getAttribute('placeholder') === topComposer.placeholder))
        : null;

      const composerContainer = bestComposerEl
        ? bestComposerEl.closest('form, [data-testid*="composer"], footer, .composer, div[class*="prompt"], div[class*="dock"], div[class*="bar"], div[class*="input-container"]')
        : null;

      const submitCandidates = buttons.map((btn) => {
        const isVisible = btn.offsetWidth > 0 || btn.offsetHeight > 0 || btn.getClientRects().length > 0;
        const isEnabled = !btn.disabled && btn.getAttribute('aria-disabled') !== 'true';
        const text = (btn.textContent || '').trim();
        const ariaLabel = btn.getAttribute('aria-label') || '';
        const title = btn.getAttribute('title') || '';
        const combined = `${ariaLabel} ${title} ${text}`.toLowerCase();
        const reasons = [];
        let score = 0;

        if (!isVisible) return { score: -100, text, ariaLabel, rejection: 'Invisible' };

        // Strictly reject collection-management buttons
        if (
          combined.includes('collection') ||
          combined.includes('folder') ||
          combined.includes('project') ||
          combined.includes('workspace') ||
          combined.includes('library') ||
          btn.hasAttribute('data-collection-id') ||
          btn.closest('[data-testid*="collection"], .collection-card, .collection-item')
        ) {
          return { score: -100, text, ariaLabel, rejection: 'Collection or project management control' };
        }

        // Strictly reject navigation, dismiss, cancel, help, settings
        if (
          combined.includes('close') ||
          combined.includes('dismiss') ||
          combined.includes('cancel') ||
          combined.includes('back') ||
          combined.includes('menu') ||
          combined.includes('help') ||
          combined.includes('share') ||
          combined.includes('settings') ||
          combined.includes('aspect') ||
          combined.includes('duration') ||
          combined.includes('model')
        ) {
          return { score: -50, text, ariaLabel, rejection: 'Navigation / settings control' };
        }

        // Proximity to composer
        const isInsideComposer = Boolean(composerContainer && composerContainer.contains(btn));
        if (isInsideComposer) {
          score += 45;
          reasons.push('Inside composer container (+45)');
        } else if (composerContainer) {
          score -= 40;
          reasons.push('Outside composer container (-40)');
        }

        // Action keywords (excluding generic "create")
        const actionKeywords = ['generate video', 'generate image', 'generate', 'run prompt', 'run', 'send prompt', 'send', 'submit'];
        for (const kw of actionKeywords) {
          if (combined.includes(kw)) {
            score += 40;
            reasons.push(`Action keyword "${kw}" (+40)`);
            break;
          }
        }

        // SVG icon check
        const hasIcon = Boolean(
          btn.querySelector('svg path, svg[data-icon*="arrow"], svg[data-icon*="send"], svg[data-icon*="run"], svg[data-icon*="play"]')
        );
        if (hasIcon) {
          score += 25;
          reasons.push('Contains directional / action SVG icon (+25)');
        }

        // Circular button check
        const classList = (btn.className || '').toString().toLowerCase();
        if (classList.includes('circle') || classList.includes('rounded-full') || classList.includes('round')) {
          score += 15;
          reasons.push('Circular styling (+15)');
        }

        if (isEnabled) {
          score += 10;
          reasons.push('Enabled (+10)');
        } else {
          reasons.push('Disabled (awaiting input)');
        }

        return {
          text: text.slice(0, 30),
          ariaLabel,
          score,
          isInsideComposer,
          isEnabled,
          reasons
        };
      }).sort((a, b) => b.score - a.score);

      // 4. Observable page state (indicators, errors, outputs)
      const indicators = Array.from(document.querySelectorAll('[data-testid*="generating"], [role="progressbar"], .flow-loader, [aria-busy="true"]')).filter((e) => e.offsetWidth > 0 || e.offsetHeight > 0);
      const stopButtons = Array.from(document.querySelectorAll('[data-testid*="stop"], button[aria-label*="Stop" i]')).filter((e) => e.offsetWidth > 0);
      const outputCards = Array.from(document.querySelectorAll('[data-testid*="output"], [data-testid*="result"], .flow-output-card, video, img')).filter((e) => e.offsetWidth > 0);
      const errorBanners = Array.from(document.querySelectorAll('[data-testid*="error"], [role="alert"], .result-error')).filter((e) => e.offsetWidth > 0);

      return {
        activeRuntimeId,
        composerCandidates: composerCandidates.slice(0, 4),
        submitCandidates: submitCandidates.slice(0, 5),
        activeIndicatorsCount: indicators.length,
        stopButtonsCount: stopButtons.length,
        visibleOutputsCount: outputCards.length,
        errorCount: errorBanners.length
      };
    }),
    10000,
    'page.evaluate (Observation)'
  );

  const screenshotPath = path.resolve(process.cwd(), 'live-flow-observation.png');
  await withTimeout(page.screenshot({ path: screenshotPath }), 5000, 'page.screenshot');
  console.log(`[Harness] Screenshot saved: ${screenshotPath}`);

  return evaluation;
}

/**
 * Controlled End-to-End Test Run on Verified Google Flow Tab
 */
export async function controlledTestRun(page, promptText = 'A cinematic shot of a sunset over calm ocean waves') {
  console.log(`\n================ CONTROLLED E2E TEST RUN ================`);
  console.log(`Target Page: ${page.url()}`);
  console.log(`Prompt: "${promptText}"`);

  // Step 1: Run observation first to ensure composer is ready
  const obs = await observeFlowPage(page);
  const topComposer = obs.composerCandidates.find((c) => c.score > 30);
  if (!topComposer) {
    throw new Error('Controlled test aborted: No verified prompt composer candidate found (score > 30).');
  }

  const topSubmit = obs.submitCandidates.find((s) => s.score > 30);
  if (!topSubmit) {
    throw new Error('Controlled test aborted: No verified Generate control found (score > 30).');
  }

  console.log(`Verified Composer: ${topComposer.tagName} (${topComposer.placeholder || topComposer.ariaLabel || 'composer'})`);
  console.log(`Verified Generate Control: "${topSubmit.text || topSubmit.ariaLabel}" (score: ${topSubmit.score})`);

  // Step 2: Enter prompt into verified composer
  console.log('\n[E2E] Step 1/3: Entering prompt into verified composer...');
  const entered = await page.evaluate((text) => {
    const el = document.querySelector('textarea, [contenteditable="true"], [role="textbox"]');
    if (!el) return false;
    el.focus();
    if (el.tagName.toLowerCase() === 'textarea' || el.tagName.toLowerCase() === 'input') {
      el.value = text;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return el.value === text;
    }
    el.textContent = text;
    el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
    return el.textContent.includes(text);
  }, promptText);

  if (!entered) {
    throw new Error('Prompt entry failed: text was not accepted by the composer element.');
  }
  console.log('[E2E] Prompt successfully entered and accepted.');

  // Step 3: Trigger generation once
  console.log('\n[E2E] Step 2/3: Activating verified Generate control...');
  const clicked = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
    // Find highest scoring action button inside or adjacent to composer
    const btn = buttons.find((b) => {
      const lower = `${b.getAttribute('aria-label') || ''} ${b.textContent || ''}`.toLowerCase();
      if (lower.includes('collection') || lower.includes('project')) return false;
      return lower.includes('generate') || lower.includes('send') || lower.includes('run') || b.querySelector('svg path');
    });
    if (!btn || btn.disabled) return false;
    btn.click();
    return true;
  });

  if (!clicked) {
    throw new Error('Generate button activation failed: control was disabled or not clickable.');
  }
  console.log('[E2E] Generate control activated.');

  // Step 4: Monitor observable state
  console.log('\n[E2E] Step 3/3: Monitoring observable page state (10s window)...');
  await page.waitForTimeout(3000);
  const postObs = await observeFlowPage(page);
  console.log(`Observable Generation Indicators: ${postObs.activeIndicatorsCount}`);
  console.log(`Observable Stop Buttons:          ${postObs.stopButtonsCount}`);
  console.log(`Observable Media Outputs:         ${postObs.visibleOutputsCount}`);

  console.log('=========================================================\n');
  return { success: true, postObs };
}

async function main() {
  const cmd = process.argv[2] || 'status';

  if (cmd === 'launch') {
    try {
      await launchDetachedChrome();
      console.log('\n[Harness] Launch completed successfully.');
      console.log('[Harness] Chrome is running detached and verified at http://127.0.0.1:9222.');
      console.log('[Harness] Next step: execute `node scripts/browser-harness.mjs observe` to inspect live DOM.');
      process.exit(0);
    } catch (err) {
      console.error(`\n[Harness] Launch FAILED: ${err.message}`);
      process.exit(1);
    }
  }

  if (cmd === 'status') {
    await showStatus();
    process.exit(0);
  }

  if (cmd === 'close') {
    closeTestBrowser();
    process.exit(0);
  }

  if (cmd === 'observe') {
    let browser;
    try {
      const procs = inspectChromeProcesses();
      const sessionInfo = determineActiveSessionType(procs);

      browser = await connectToBrowser(8000);
      console.log(`[Harness] Connected to Chrome DevTools Protocol at ${CDP_URL}.`);
      console.log(`[Harness] Verified Session Type: ${sessionInfo.label}`);

      // 1. List actual browser tabs
      console.log('\n--- ACTIVE BROWSER TABS ---');
      const allPages = [];
      for (const ctx of browser.contexts()) {
        for (const p of ctx.pages()) {
          const t = await safePageTitle(p, 1500);
          const u = p.url();
          allPages.push({ title: t, url: u, page: p });
          console.log(`  - [${allPages.length}] "${t}" (${u})`);
        }
      }

      // 2. Find real Google Flow tab
      const flowTab = allPages.find((item) => isGoogleFlowUrl(item.url));

      if (!flowTab) {
        console.error('\n[Harness] Google Flow tab was NOT found among currently open tabs.');
        console.log(`\nPlease navigate to https://flow.google/ in your Chrome window, then rerun 'node scripts/browser-harness.mjs observe'.`);
        await browser.close();
        process.exit(1);
      }

      console.log(`\n[Harness] Found Google Flow Tab: "${flowTab.title}" (${flowTab.url})`);

      // 3. Inspect DOM in observation-only mode
      const results = await observeFlowPage(flowTab.page);
      console.log('\n================ LIVE OBSERVATION REPORT ================');
      console.log(`Connected Session Profile: ${sessionInfo.label}`);
      console.log(`Live Page URL:             ${flowTab.page.url()}`);
      console.log(`Page Title:                ${await safePageTitle(flowTab.page, 2000)}`);
      console.log(`Batch Studio Content Script: ${results.activeRuntimeId ? `ATTACHED (${results.activeRuntimeId})` : 'NOT ATTACHED (reload or inject extension)'}`);
      console.log('\nTop Composer Candidates:');
      console.table(results.composerCandidates);
      console.log('\nTop Submit Control Candidates (Collections strictly excluded):');
      console.table(results.submitCandidates);
      console.log(`\nActive generation indicators: ${results.activeIndicatorsCount}`);
      console.log(`Stop buttons found:           ${results.stopButtonsCount}`);
      console.log(`Visible media outputs:        ${results.visibleOutputsCount}`);
      console.log(`Visible error banners:        ${results.errorCount}`);
      console.log('=========================================================\n');

      await browser.close();
      process.exit(0);
    } catch (err) {
      console.error('\n[Harness] Observation failed:', err.message);
      if (browser) {
        try { await browser.close(); } catch {}
      }
      process.exit(1);
    }
  }

  if (cmd === 'test-run') {
    const promptArg = process.argv[3] || 'A cinematic sunset over ocean waves';
    let browser;
    try {
      browser = await connectToBrowser(8000);
      const page = await findPlatformPage(browser, 'google_flow');
      if (!page) {
        throw new Error('Google Flow tab not open.');
      }
      await controlledTestRun(page, promptArg);
      await browser.close();
      process.exit(0);
    } catch (err) {
      console.error('\n[Harness] Controlled test run failed:', err.message);
      if (browser) {
        try { await browser.close(); } catch {}
      }
      process.exit(1);
    }
  }

  console.error(`[Harness] Unknown command: "${cmd}". Supported: status, observe, launch, test-run, close`);
  process.exit(1);
}

if (process.argv[1] && process.argv[1].endsWith('browser-harness.mjs')) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
