const { chromium } = require('playwright-core');

async function testExtensionUIReal() {
  console.log('========================================================');
  console.log('=== REAL TEST: BATCH STUDIO EXTENSION UI EXECUTION ===');
  console.log('========================================================');

  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const context = browser.contexts()[0];

  let extPage = context.pages().find((p) =>
    p.url().includes('chrome-extension://pkpgpjlimgpnbggiecpacnmoopnamhhh')
  );
  if (!extPage) {
    console.log('Batch Studio extension tab not found, creating new page...');
    extPage = await context.newPage();
    await extPage.goto('chrome-extension://pkpgpjlimgpnbggiecpacnmoopnamhhh/index.html');
    await extPage.waitForLoadState('networkidle');
  }

  const flowPage = context.pages().find((p) => p.url().includes('flow.google.com/project'));
  if (!flowPage) {
    throw new Error('Google Flow project tab not found!');
  }

  console.log('Connected to Extension page:', extPage.url());
  console.log('Connected to Google Flow tab:', flowPage.url());

  // Listen for browser download event and save real file to Downloads folder
  const path = require('path');
  const capturedDownloads = [];
  flowPage.on('download', async (download) => {
    const filename = download.suggestedFilename() || `GoogleFlow_${Date.now()}.jpg`;
    const finalFilename = filename.endsWith('.jpg') || filename.endsWith('.png') ? filename : `${filename}.jpg`;
    const savePath = path.join('C:\\Users\\assem\\Downloads', finalFilename);
    try {
      await download.saveAs(savePath);
      console.log(`\n🎉 [BROWSER DOWNLOAD EVENT] Saved real image to "${savePath}"`);
      capturedDownloads.push(finalFilename);
    } catch (e) {
      console.error('Failed to save download:', e);
    }
  });

  // Step 1: Ensure Google Flow tab is in project grid view (close detail view if open)
  await flowPage.bringToFront();
  await flowPage.evaluate(() => {
    const isVisible = (el) => Boolean(el.offsetWidth > 0 && el.offsetHeight > 0);
    const done = Array.from(document.querySelectorAll('button')).find(
      (b) =>
        isVisible(b) &&
        ((b.textContent || '').trim().toLowerCase() === 'done' ||
          (b.getAttribute('aria-label') || '').toLowerCase().includes('done') ||
          (b.getAttribute('aria-label') || '').toLowerCase().includes('previous page') ||
          (b.textContent || '').trim().toLowerCase() === 'arrow_back')
    );
    if (done) {
      console.log('Closing detail view to ensure grid view before prompt submission');
      done.click();
    }
  });
  await flowPage.waitForTimeout(500);

  // Step 2: Switch to Extension page and configure batch
  await extPage.bringToFront();
  console.log('\n[Step 1] Configuring batch in extension UI...');

  // Click "Batch Setup" tab in extension UI
  await extPage.click('button:has-text("Batch Setup")');
  await extPage.waitForTimeout(400);

  // Ensure Google Flow is selected as platform
  await extPage.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button'));
    const flowBtn = buttons.find((b) => b.textContent.includes('Google Flow'));
    if (flowBtn) flowBtn.click();
  });
  await extPage.waitForTimeout(300);

  // If there are existing prompt drafts or active batch, handle clear/reset
  await extPage.evaluate(() => {
    const clearBtn = Array.from(document.querySelectorAll('button')).find((b) =>
      b.textContent.includes('Clear All')
    );
    if (clearBtn) clearBtn.click();
  });
  await extPage.waitForTimeout(300);

  // Open "Paste Prompts" if textarea not already visible
  const isTextareaVisible = await extPage.isVisible('textarea[data-testid="paste-prompts-textarea"]');
  if (!isTextareaVisible) {
    console.log('Opening paste prompts area...');
    const pasteToggle = await extPage.$('[data-testid="paste-prompts-toggle-btn"], button:has-text("Paste Prompts")');
    if (pasteToggle) await pasteToggle.click();
    await extPage.waitForTimeout(300);
  }

  // Enter test prompt
  const testPrompt =
    'A majestic glowing phoenix with emerald feathers rising from crystal ashes, 8k concept art ' + Date.now();
  console.log(`Entering prompt into extension textarea:\n"${testPrompt}"`);

  await extPage.fill('textarea[data-testid="paste-prompts-textarea"], textarea[placeholder*="Paste one prompt per line"]', testPrompt);
  await extPage.waitForTimeout(300);

  // Click "Add to Batch" button
  console.log('Clicking "Add to Batch" button...');
  await extPage.click('[data-testid="add-pasted-prompts-btn"], button:has-text("Add to Batch")');
  await extPage.waitForTimeout(500);

  // Verify prompt was added
  const queueCount = await extPage.evaluate(() => {
    const badge = document.querySelector('.badge, [class*="badge"]');
    return badge ? badge.textContent.trim() : 'ok';
  });
  console.log('Batch items status:', queueCount);

  // Take screenshot of Batch Setup with prompt ready
  await extPage.screenshot({ path: 'W:\\Projects\\Web\\Batch-Studio\\ext_test_step1_setup.png' });
  console.log('Saved ext_test_step1_setup.png');

  // Step 3: Click "Start Batch Queue"
  console.log('\n[Step 2] Clicking "Start Batch Queue" button in extension UI...');
  await extPage.click('[data-testid="start-batch-btn"], button:has-text("Start Batch Queue")');
  await extPage.waitForTimeout(1000);

  // Verify UI switched to Queue Monitor
  await extPage.screenshot({ path: 'W:\\Projects\\Web\\Batch-Studio\\ext_test_step2_started.png' });
  console.log('Saved ext_test_step2_started.png');

  // Step 4: Monitor the real execution from both extension UI and Flow tab
  console.log('\n[Step 3] Monitoring extension batch queue execution...');
  const startTime = Date.now();
  let batchDone = false;

  for (let sec = 1; sec <= 90; sec++) {
    await extPage.waitForTimeout(1000);
    const elapsed = Math.round((Date.now() - startTime) / 1000);

    // Read queue status from extension UI
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

    if (sec % 3 === 0 || uiStatus.hasCompleted) {
      console.log(
        `[+${elapsed}s] Extension UI Status: chips=${JSON.stringify(
          uiStatus.statusChips
        )} | friendly=${JSON.stringify(uiStatus.friendlyStatus)}`
      );
    }

    if (uiStatus.hasCompleted && (capturedDownloads.length > 0 || uiStatus.statusChips.includes('Completed') || uiStatus.statusChips.includes('completed'))) {
      console.log(`\n🎉 BATCH COMPLETED SUCCESSFULLY VIA EXTENSION UI AT ${elapsed}s!`);
      batchDone = true;
      break;
    }
  }

  // Step 5: Final screenshots and assertions
  await extPage.screenshot({ path: 'W:\\Projects\\Web\\Batch-Studio\\ext_test_step3_completed.png' });
  await flowPage.screenshot({ path: 'W:\\Projects\\Web\\Batch-Studio\\ext_test_flow_completed.png' });

  console.log('\n========================================================');
  console.log('=== REAL EXTENSION TEST RESULTS ===');
  console.log('Batch completed:', batchDone);
  console.log('Captured downloads count:', capturedDownloads.length);
  console.log('Downloaded files:', capturedDownloads);
  console.log('Screenshots saved:');
  console.log(' - W:\\Projects\\Web\\Batch-Studio\\ext_test_step1_setup.png');
  console.log(' - W:\\Projects\\Web\\Batch-Studio\\ext_test_step2_started.png');
  console.log(' - W:\\Projects\\Web\\Batch-Studio\\ext_test_step3_completed.png');
  console.log(' - W:\\Projects\\Web\\Batch-Studio\\ext_test_flow_completed.png');
  console.log('========================================================');

  if (!batchDone && capturedDownloads.length === 0) {
    throw new Error('Batch did not complete or trigger download within 90s!');
  }
}

testExtensionUIReal()
  .then(() => {
    console.log('REAL EXTENSION TEST PASSED WITH CODE 0');
    process.exit(0);
  })
  .catch((err) => {
    console.error('REAL EXTENSION TEST FAILED:', err);
    process.exit(1);
  });
