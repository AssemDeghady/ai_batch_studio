const { chromium } = require('playwright-core');

async function testMultiPrompt() {
  console.log('========================================================');
  console.log('=== MULTI-PROMPT 2-ITEM BATCH STUDIO EXECUTION TEST ===');
  console.log('========================================================');

  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const context = browser.contexts()[0];

  let extPage = context.pages().find((p) =>
    p.url().includes('chrome-extension://pkpgpjlimgpnbggiecpacnmoopnamhhh')
  );
  if (!extPage) {
    extPage = await context.newPage();
    await extPage.goto('chrome-extension://pkpgpjlimgpnbggiecpacnmoopnamhhh/index.html');
    await extPage.waitForLoadState('networkidle');
  }

  const flowPage = context.pages().find((p) => p.url().includes('flow.google.com/project'));
  if (!flowPage) {
    throw new Error('Google Flow project tab not found!');
  }

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

  // Ensure Flow tab is in project grid view (close detail view if open)
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

  // Switch to Extension UI
  await extPage.bringToFront();
  await extPage.click('button:has-text("Batch Setup")');
  await extPage.waitForTimeout(400);

  // Ensure Google Flow is selected
  await extPage.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button'));
    const flowBtn = buttons.find((b) => b.textContent.includes('Google Flow'));
    if (flowBtn) flowBtn.click();
  });
  await extPage.waitForTimeout(300);

  // Clear previous drafts if any
  await extPage.evaluate(() => {
    const clearBtn = Array.from(document.querySelectorAll('button')).find((b) =>
      b.textContent.includes('Clear All')
    );
    if (clearBtn) clearBtn.click();
  });
  await extPage.waitForTimeout(300);

  // Open paste prompts textarea if needed
  const isTextareaVisible = await extPage.isVisible('textarea[data-testid="paste-prompts-textarea"]');
  if (!isTextareaVisible) {
    const pasteToggle = await extPage.$('[data-testid="paste-prompts-toggle-btn"], button:has-text("Paste Prompts")');
    if (pasteToggle) await pasteToggle.click();
    await extPage.waitForTimeout(300);
  }

  // 2 distinct prompts
  const time = Date.now();
  const prompts = [
    `Cyberpunk robotic cat playing chess on a neon rooftop ${time}`,
    `Ancient obsidian temple glowing under a purple aurora borealis ${time}`
  ].join('\n');

  console.log('Adding 2 prompts to batch:\n', prompts);
  await extPage.fill('textarea[data-testid="paste-prompts-textarea"], textarea[placeholder*="Paste one prompt per line"]', prompts);
  await extPage.waitForTimeout(300);

  // Click "Add to Batch"
  await extPage.click('[data-testid="add-pasted-prompts-btn"], button:has-text("Add to Batch")');
  await extPage.waitForTimeout(500);

  // Click "Start Batch Queue"
  console.log('\nClicking "Start Batch Queue"...');
  await extPage.click('[data-testid="start-batch-btn"], button:has-text("Start Batch Queue")');
  await extPage.waitForTimeout(1000);

  // Monitor until 2/2 completed
  const startTime = Date.now();
  let batchDone = false;

  for (let sec = 1; sec <= 180; sec++) {
    await extPage.waitForTimeout(1000);
    const elapsed = Math.round((Date.now() - startTime) / 1000);

    const uiStatus = await extPage.evaluate(() => {
      const text = document.body.innerText;
      const statusChips = Array.from(
        document.querySelectorAll('.status-chip, .badge, [class*="status"]')
      ).map((c) => c.textContent.trim());
      return {
        hasAllCompleted: text.includes('2 / 2') || text.includes('2/2') || (text.includes('Batch completed') && text.includes('Completed')),
        statusChips,
        summary: text.slice(0, 200).replace(/\n+/g, ' ')
      };
    });

    if (sec % 3 === 0 || uiStatus.hasAllCompleted) {
      console.log(`[+${elapsed}s] Extension UI: chips=${JSON.stringify(uiStatus.statusChips)}`);
    }

    if (uiStatus.hasAllCompleted && capturedDownloads.length >= 2) {
      console.log(`\n🎉🎉 FULL 2-TASK BATCH COMPLETED SUCCESSFULLY AT ${elapsed}s!`);
      batchDone = true;
      break;
    }
  }

  console.log('\n========================================================');
  console.log('=== MULTI-TASK BATCH RESULTS ===');
  console.log('Batch completed:', batchDone);
  console.log('Captured downloads count:', capturedDownloads.length);
  console.log('Downloaded files:', capturedDownloads);
  console.log('========================================================');

  if (!batchDone || capturedDownloads.length < 2) {
    throw new Error(`Batch test did not complete 2 tasks. Got ${capturedDownloads.length} downloads.`);
  }
}

testMultiPrompt()
  .then(() => {
    console.log('MULTI-PROMPT TEST PASSED WITH CODE 0');
    process.exit(0);
  })
  .catch((err) => {
    console.error('MULTI-PROMPT TEST FAILED:', err);
    process.exit(1);
  });
