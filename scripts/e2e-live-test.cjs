const { chromium } = require('playwright-core');

async function runLiveCycleTest() {
  console.log('========================================================');
  console.log('=== STARTING BATCH STUDIO GOOGLE FLOW LIVE E2E TEST ===');
  console.log('========================================================');

  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const context = browser.contexts()[0];
  const flowPage = context.pages().find((p) => p.url().includes('flow.google.com/project'));

  if (!flowPage) {
    throw new Error('Google Flow project tab not found in connected browser!');
  }

  console.log('Connected to Google Flow project tab:', flowPage.url());

  // Listen for browser downloads
  const capturedDownloads = [];
  flowPage.on('download', (download) => {
    const filename = download.suggestedFilename();
    console.log(`\n🎉 [BROWSER EVENT] Official Download Started: "${filename}"`);
    capturedDownloads.push(filename);
  });

  // Verify composer is present and ready
  const isReady = await flowPage.evaluate(() => {
    const composer = document.querySelector('div.ProseMirror[contenteditable="true"]');
    return Boolean(composer && composer.offsetWidth > 0);
  });
  console.log('Composer ready for input:', isReady);
  if (!isReady) {
    // If inside detail view, close it first
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
      if (done) done.click();
    });
    await flowPage.waitForTimeout(500);
  }

  // Two sequential test prompts to prove continuous queue operation
  const testPrompts = [
    'A magnificent luminescent dragon soaring above an ancient floating castle at sunset, highly detailed concept art',
    'A cute steampunk robotic hedgehog tending to glowing clockwork flowers in a Victorian conservatory'
  ];

  for (let i = 0; i < testPrompts.length; i++) {
    const promptText = testPrompts[i];
    console.log(`\n--------------------------------------------------------`);
    console.log(`>>> EXECUTING QUEUE ITEM ${i + 1}/${testPrompts.length} <<<`);
    console.log(`Prompt: "${promptText}"`);
    console.log(`--------------------------------------------------------`);

    // Ensure we are in Grid view
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

    // Record baseline output image URLs
    const baselineUrls = await flowPage.evaluate(() => {
      const imgs = Array.from(document.querySelectorAll('img[src*="flow-content.google"]'));
      return imgs.map((img) => img.src);
    });
    console.log(`[Queue ${i + 1}] Baseline images on page:`, baselineUrls.length);

    // Step 1: Input Prompt into ProseMirror
    console.log(`[Queue ${i + 1}] Entering prompt text into ProseMirror composer...`);
    await flowPage.click('div.ProseMirror[contenteditable="true"]');
    await flowPage.keyboard.press('Control+A');
    await flowPage.keyboard.press('Backspace');
    await flowPage.keyboard.type(promptText, { delay: 5 });
    await flowPage.waitForTimeout(500);

    // Step 2: Click Generate button via hardware click
    console.log(`[Queue ${i + 1}] Clicking Generate (arrow_forward) button via hardware click...`);
    await flowPage.click('button.generate-icon-button, button[aria-label*="Start generation" i]');
    console.log(`[Queue ${i + 1}] Clicked generate button! Also sending Enter key on composer...`);
    await flowPage.keyboard.press('Enter');

    // Step 3: Wait for generation to complete (~18 - 35 seconds)
    console.log(`[Queue ${i + 1}] Observing generation progress...`);
    const genStart = Date.now();
    let newImageUrl = null;

    for (let sec = 1; sec <= 60; sec++) {
      await flowPage.waitForTimeout(1000);
      const elapsed = Math.round((Date.now() - genStart) / 1000);

      const check = await flowPage.evaluate((knownUrls) => {
        const knownSet = new Set(knownUrls);
        const allImgs = Array.from(document.querySelectorAll('img[src*="flow-content.google"]'));
        const newImgs = allImgs.filter((img) => !knownSet.has(img.src));

        const isVisible = (el) => Boolean(el.offsetWidth > 0 && el.offsetHeight > 0);
        const spinners = Array.from(
          document.querySelectorAll('mat-progress-spinner, mat-spinner, [role="progressbar"], [class*="shimmer" i]')
        ).filter(isVisible);

        return {
          totalImgs: allImgs.length,
          newImgsCount: newImgs.length,
          newImgSrc: newImgs[0]?.src || null,
          hasVisibleSpinner: spinners.length > 0
        };
      }, baselineUrls);

      if (sec % 3 === 0 || check.newImgsCount > 0) {
        console.log(`[+${elapsed}s] Total images: ${check.totalImgs} | New: ${check.newImgsCount} | Spinner visible: ${check.hasVisibleSpinner}`);
      }

      if (check.newImgsCount > 0 && !check.hasVisibleSpinner) {
        console.log(`\n🎉 [Queue ${i + 1}] Generation finished in ${elapsed}s! New Image: ${check.newImgSrc.slice(0, 70)}...`);
        newImageUrl = check.newImgSrc;
        break;
      }
    }

    if (!newImageUrl) {
      throw new Error(`Queue item ${i + 1} generation timed out after 60s!`);
    }

    // Step 4: Click the new image tile to open Single-Image Detail View
    console.log(`[Queue ${i + 1}] Clicking generated image tile to open Detail View...`);
    await flowPage.evaluate((targetUrl) => {
      const img = Array.from(document.querySelectorAll('img[src*="flow-content.google"]')).find(
        (im) => im.src === targetUrl
      );
      if (img) {
        img.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, composed: true }));
        img.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, composed: true }));
        img.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
      }
    }, newImageUrl);

    await flowPage.waitForTimeout(1000);

    // Step 5: Click Download button in Detail View
    console.log(`[Queue ${i + 1}] Finding and clicking visible Download button in Detail View...`);
    let dlClicked = await flowPage.evaluate(() => {
      const isVisible = (el) => Boolean(el.offsetWidth > 0 && el.offsetHeight > 0);
      const btns = Array.from(document.querySelectorAll('button, [role="menuitem"], .mat-mdc-menu-item')).filter(isVisible);
      const dlBtn = btns.find((b) => {
        const aria = (b.getAttribute('aria-label') || '').toLowerCase();
        const txt = (b.textContent || '').trim().toLowerCase();
        return aria === 'download media' || (aria.includes('download') && !aria.includes('start')) || txt === 'download' || txt.includes('download media');
      });
      if (dlBtn) {
        dlBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, composed: true }));
        dlBtn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, composed: true }));
        dlBtn.click();
        return { clicked: true, label: dlBtn.getAttribute('aria-label') || dlBtn.textContent.trim() };
      }
      return { clicked: false };
    });

    if (!dlClicked.clicked) {
      // In responsive/narrower layouts, Google Flow collapses header actions into more_vert ("More options")
      console.log(`[Queue ${i + 1}] Direct download button not in header; opening more_vert menu...`);
      await flowPage.evaluate(() => {
        const isVisible = (el) => Boolean(el.offsetWidth > 0 && el.offsetHeight > 0);
        const moreVert = Array.from(document.querySelectorAll('button')).find(
          (b) =>
            isVisible(b) &&
            ((b.getAttribute('aria-label') || '').toLowerCase().includes('more options') ||
              (b.textContent || '').trim() === 'more_vert')
        );
        if (moreVert) moreVert.click();
      });
      await flowPage.waitForTimeout(400);

      dlClicked = await flowPage.evaluate(() => {
        const isVisible = (el) => Boolean(el.offsetWidth > 0 && el.offsetHeight > 0);
        const items = Array.from(document.querySelectorAll('[role="menuitem"], .mat-mdc-menu-item, button')).filter(isVisible);
        const dlItem = items.find((b) => (b.textContent || '').toLowerCase().includes('download media') || (b.getAttribute('aria-label') || '').toLowerCase().includes('download'));
        if (dlItem) {
          dlItem.click();
          return { clicked: true, label: dlItem.textContent.trim() };
        }
        return { clicked: false };
      });
    }

    console.log(`[Queue ${i + 1}] Download button status:`, dlClicked);

    if (!dlClicked.clicked) {
      throw new Error(`Failed to find Download button in detail view for item ${i + 1}!`);
    }

    await flowPage.waitForTimeout(600);

    // Step 6: Click "1K Original size" from the menu
    console.log(`[Queue ${i + 1}] Clicking "1K Original size" in resolution menu...`);
    const clicked1K = await flowPage.evaluate(() => {
      const isVisible = (el) => Boolean(el.offsetWidth > 0 && el.offsetHeight > 0);
      const candidates = Array.from(document.querySelectorAll('button, [role="menuitem"], [role="option"]')).filter(
        isVisible
      );
      const target = candidates.find((c) => {
        const txt = (c.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
        return (txt.includes('original size') || txt.includes('1k')) && !txt.includes('2k') && !txt.includes('4k');
      });
      if (target) {
        target.click();
        return (target.textContent || '').replace(/\s+/g, ' ').trim();
      }
      return null;
    });
    console.log(`[Queue ${i + 1}] Clicked resolution option:`, clicked1K);

    if (!clicked1K) {
      throw new Error(`Failed to find "1K Original size" option for item ${i + 1}!`);
    }

    // Wait for the native download to trigger and complete
    await flowPage.waitForTimeout(2500);

    // Step 7: Click "Done" button to return to the project grid
    console.log(`[Queue ${i + 1}] Clicking "Done" button to return to project grid...`);
    const doneClicked = await flowPage.evaluate(() => {
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
        done.click();
        return true;
      }
      return false;
    });
    console.log(`[Queue ${i + 1}] Clicked Done button:`, doneClicked);

    await flowPage.waitForTimeout(1000);
    console.log(`>>> QUEUE ITEM ${i + 1} COMPLETED SUCCESSFULLY! <<<`);
  }

  console.log('\n========================================================');
  console.log('=== FINAL RESULTS ===');
  console.log('All queue items completed successfully!');
  console.log('Captured downloads count:', capturedDownloads.length);
  console.log('Files downloaded:', capturedDownloads);
  console.log('========================================================');

  await flowPage.screenshot({ path: 'W:\\Projects\\Web\\Batch-Studio\\live_cycle_final_success.png' });
  console.log('Screenshot saved to W:\\Projects\\Web\\Batch-Studio\\live_cycle_final_success.png');
}

runLiveCycleTest()
  .then(() => {
    console.log('E2E TEST RUN COMPLETED WITH EXIT CODE 0');
    process.exit(0);
  })
  .catch((err) => {
    console.error('E2E TEST RUN FAILED:', err);
    process.exit(1);
  });
