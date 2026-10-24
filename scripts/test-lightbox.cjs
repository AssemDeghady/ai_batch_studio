const { chromium } = require('playwright-core');

(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const chatPage = browser.contexts()[0].pages().find((p) => p.url().includes('chatgpt.com'));

  const result = await chatPage.evaluate(async () => {
    // Find all preview buttons
    const previewBtns = Array.from(
      document.querySelectorAll('button[data-testid="generated-image-preview"]')
    );
    console.log('Found preview buttons count:', previewBtns.length);
    if (previewBtns.length === 0) return { error: 'No preview buttons' };

    // Target the last preview button (Turn 3 dragon)
    const targetBtn = previewBtns[previewBtns.length - 1];
    targetBtn.click();

    // Wait 800ms for lightbox
    await new Promise((r) => setTimeout(r, 800));

    // Look for download button
    const dlBtn = document.querySelector(
      'button[aria-label="Download"], a[aria-label="Download"], [data-testid="download-image-button"]'
    );
    const closeBtn = document.querySelector(
      'button[aria-label="Close viewer"], button[aria-label="Close"]'
    );

    const info = {
      previewButtonsCount: previewBtns.length,
      hasDlBtn: Boolean(dlBtn),
      dlBtnAria: dlBtn ? dlBtn.getAttribute('aria-label') : null,
      dlBtnTag: dlBtn ? dlBtn.tagName : null,
      hasCloseBtn: Boolean(closeBtn),
      closeBtnAria: closeBtn ? closeBtn.getAttribute('aria-label') : null
    };

    // Close viewer if open
    if (closeBtn) closeBtn.click();

    return info;
  });

  console.log('Lightbox test result:', JSON.stringify(result, null, 2));

  await browser.close();
  process.exit(0);
})();
