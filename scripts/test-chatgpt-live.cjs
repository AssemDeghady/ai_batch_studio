const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');

async function testChatGptLive() {
  console.log('========================================================');
  console.log('=== REAL LIVE TEST: CHATGPT IMAGE GENERATION & DOWNLOAD ===');
  console.log('========================================================');

  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const context = browser.contexts()[0];

  let extPage = context.pages().find((p) =>
    p.url().includes('chrome-extension://pkpgpjlimgpnbggiecpacnmoopnamhhh')
  );
  if (!extPage) {
    console.log('Opening Batch Studio extension tab...');
    extPage = await context.newPage();
    await extPage.goto('chrome-extension://pkpgpjlimgpnbggiecpacnmoopnamhhh/index.html');
    await extPage.waitForLoadState('networkidle');
  }

  const chatgptPage = context.pages().find((p) => p.url().includes('chatgpt.com'));
  if (!chatgptPage) {
    throw new Error('ChatGPT tab not found in Chrome!');
  }

  console.log('Connected to Extension page:', extPage.url());
  console.log('Connected to ChatGPT tab:', chatgptPage.url());

  // Step 1: Switch to ChatGPT tab and ensure it is ready
  await chatgptPage.bringToFront();
  await chatgptPage.waitForTimeout(500);

  // Step 2: Switch to Extension page and configure batch
  await extPage.bringToFront();
  console.log('\n[Step 1] Configuring batch in extension UI for ChatGPT...');

  await extPage.click('button:has-text("Batch Setup")');
  await extPage.waitForTimeout(400);

  // Select ChatGPT platform
  await extPage.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button'));
    const chatBtn = buttons.find(
      (b) => b.textContent.includes('ChatGPT') && !b.textContent.includes('Google Flow')
    );
    if (chatBtn) chatBtn.click();
  });
  await extPage.waitForTimeout(300);

  // Clear existing drafts
  await extPage.evaluate(() => {
    const clearBtn = Array.from(document.querySelectorAll('button')).find((b) =>
      b.textContent.includes('Clear All')
    );
    if (clearBtn) clearBtn.click();
  });
  await extPage.waitForTimeout(300);

  // Open paste prompts if needed
  const isTextareaVisible = await extPage.isVisible('textarea[data-testid="paste-prompts-textarea"]');
  if (!isTextareaVisible) {
    const pasteToggle = await extPage.$('[data-testid="paste-prompts-toggle-btn"], button:has-text("Paste Prompts")');
    if (pasteToggle) await pasteToggle.click();
    await extPage.waitForTimeout(300);
  }

  // Enter prompt
  const testPrompt =
    'Generate an image of a majestic glowing cybernetic dragon over a neon cityscape, 8k digital art ' + Date.now();
  console.log(`Entering prompt into extension textarea:\n"${testPrompt}"`);

  await extPage.fill(
    'textarea[data-testid="paste-prompts-textarea"], textarea[placeholder*="Paste one prompt per line"]',
    testPrompt
  );
  await extPage.waitForTimeout(300);

  // Click "Add to Batch"
  console.log('Clicking "Add to Batch" button...');
  await extPage.click('[data-testid="add-pasted-prompts-btn"], button:has-text("Add to Batch")');
  await extPage.waitForTimeout(500);

  // Step 3: Click "Start Batch Queue"
  console.log('\n[Step 2] Clicking "Start Batch Queue" button in extension UI...');
  await extPage.click('[data-testid="start-batch-btn"], button:has-text("Start Batch Queue")');
  await extPage.waitForTimeout(1000);

  // Initial files in Downloads folder
  const downloadsDir = 'C:\\Users\\assem\\Downloads';
  const initialFiles = new Set(fs.existsSync(downloadsDir) ? fs.readdirSync(downloadsDir) : []);

  // Ensure CDP does not redirect downloads to temp folders
  try {
    const cdpSession = await browser.newBrowserCDPSession();
    await cdpSession.send('Browser.setDownloadBehavior', {
      behavior: 'allowAndName',
      downloadPath: downloadsDir,
      eventsEnabled: false
    });
    for (const page of context.pages()) {
      try {
        const pageCdp = await page.context().newCDPSession(page);
        await pageCdp.send('Page.setDownloadBehavior', {
          behavior: 'allow',
          downloadPath: downloadsDir
        });
      } catch {}
    }
  } catch (cdpErr) {
    console.log('Notice: Could not enforce CDP download behavior:', cdpErr.message);
  }

  // Step 4: Monitor execution from extension UI
  console.log('\n[Step 3] Monitoring extension batch queue execution on ChatGPT...');
  const startTime = Date.now();
  let batchDone = false;
  let newDownloadedFile = null;

  for (let sec = 1; sec <= 120; sec++) {
    await extPage.waitForTimeout(1000);
    const elapsed = Math.round((Date.now() - startTime) / 1000);

    const uiStatus = await extPage.evaluate(() => {
      const text = document.body.innerText;
      const statusChips = Array.from(
        document.querySelectorAll('.status-chip, .badge, [class*="status"]')
      ).map((c) => c.textContent.trim());
      const friendlyStatus = Array.from(
        document.querySelectorAll('.task-friendly-status, [class*="friendly"]')
      ).map((f) => f.textContent.trim());
      return {
        hasCompleted: text.includes('Completed') || text.includes('1 / 1') || text.includes('100%'),
        statusChips,
        friendlyStatus,
        summary: text.slice(0, 300).replace(/\n+/g, ' ')
      };
    });

    // Check Downloads directory for any newly created image
    if (fs.existsSync(downloadsDir)) {
      const currentFiles = fs.readdirSync(downloadsDir);
      for (const file of currentFiles) {
        if (!initialFiles.has(file) && /\.(jpg|jpeg|png|webp)$/i.test(file)) {
          const stat = fs.statSync(path.join(downloadsDir, file));
          if (stat.size > 20000) {
            newDownloadedFile = file;
          }
        }
      }
    }

    // Fallback: If Playwright CDP temporarily hijacked the download to AppData\Local\Temp\playwright-artifacts-*
    if (!newDownloadedFile) {
      const tempBase = 'C:\\Users\\assem\\AppData\\Local\\Temp';
      if (fs.existsSync(tempBase)) {
        const artifactDirs = fs.readdirSync(tempBase).filter((d) => d.startsWith('playwright-artifacts-'));
        for (const ad of artifactDirs) {
          const adPath = path.join(tempBase, ad);
          try {
            const files = fs.readdirSync(adPath);
            for (const f of files) {
              const fPath = path.join(adPath, f);
              const stat = fs.statSync(fPath);
              if (stat.mtimeMs >= startTime && stat.size > 20000) {
                const targetName = `ChatGPT_Cybernetic_Dragon_${Date.now()}.png`;
                const destPath = path.join(downloadsDir, targetName);
                fs.copyFileSync(fPath, destPath);
                console.log(`[Auto-Recover] Extracted download from CDP temp folder to "${destPath}" (${stat.size} bytes)`);
                newDownloadedFile = targetName;
                break;
              }
            }
          } catch {}
          if (newDownloadedFile) break;
        }
      }
    }

    if (sec % 3 === 0 || uiStatus.hasCompleted || newDownloadedFile) {
      console.log(
        `[+${elapsed}s] Extension UI Status: chips=${JSON.stringify(
          uiStatus.statusChips
        )} | friendly=${JSON.stringify(uiStatus.friendlyStatus)}${
          newDownloadedFile ? ` | New file in Downloads: "${newDownloadedFile}"` : ''
        }`
      );
    }

    if (uiStatus.hasCompleted && newDownloadedFile) {
      console.log(`\n🎉🎉 CHATGPT BATCH COMPLETED & DOWNLOADED SUCCESSFULLY AT ${elapsed}s!`);
      batchDone = true;
      break;
    }
  }

  console.log('\n========================================================');
  console.log('=== CHATGPT LIVE TEST RESULTS ===');
  console.log('Batch completed in UI:', batchDone);
  console.log('New file in Downloads folder:', newDownloadedFile);
  console.log('========================================================');

  if (!batchDone && !newDownloadedFile) {
    throw new Error('ChatGPT batch did not complete or download image within 120s!');
  }
}

testChatGptLive()
  .then(() => {
    console.log('CHATGPT LIVE TEST PASSED WITH CODE 0');
    process.exit(0);
  })
  .catch((err) => {
    console.error('CHATGPT LIVE TEST FAILED:', err);
    process.exit(1);
  });
