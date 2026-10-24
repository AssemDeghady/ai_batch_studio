const { chromium } = require('playwright-core');

(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const chatPage = browser.contexts()[0].pages().find((p) => p.url().includes('chatgpt.com'));

  const previewLocators = chatPage.locator('button[data-testid="generated-image-preview"]');
  const count = await previewLocators.count();
  console.log('Preview locators count:', count);

  // Click the last preview button with Playwright real pointer click
  const lastBtn = previewLocators.nth(count - 1);
  await lastBtn.scrollIntoViewIfNeeded();
  await lastBtn.click();
  await chatPage.waitForTimeout(1000);

  const info = await chatPage.evaluate(() => {
    const allButtons = Array.from(document.querySelectorAll('button')).map((b) => ({
      aria: b.getAttribute('aria-label'),
      testid: b.getAttribute('data-testid'),
      text: b.innerText.trim()
    })).filter((b) => b.aria || b.testid || b.text);
    return { allButtons: allButtons.slice(-15) };
  });

  console.log('Buttons visible after real click:');
  console.log(JSON.stringify(info, null, 2));

  // Check if close viewer exists
  const closeBtn = chatPage.locator('button[aria-label*="Close" i]');
  if (await closeBtn.count() > 0) {
    console.log('Close button found! Lightbox opened successfully!');
    await closeBtn.first().click();
  } else {
    console.log('No close button found.');
  }

  await browser.close();
  process.exit(0);
})();
