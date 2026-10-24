const { chromium } = require('playwright-core');

async function run() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const context = browser.contexts()[0];
  const flowPage = context.pages().find((p) => p.url().includes('flow.google.com/project'));
  await flowPage.bringToFront();

  // Click on the image button
  const imgBtn = await flowPage.$('button[aria-label*="Ancient obsidian temple"]');
  console.log('imgBtn found?', Boolean(imgBtn));
  if (imgBtn) {
    await imgBtn.click();
    await flowPage.waitForTimeout(800);
  }

  // Now inspect visible buttons in detail view
  const btns = await flowPage.evaluate(() => {
    return Array.from(document.querySelectorAll('button')).map(b => ({
      text: b.textContent.trim().replace(/\s+/g, ' '),
      aria: b.getAttribute('aria-label'),
      visible: b.offsetWidth > 0 && b.offsetHeight > 0
    })).filter(b => b.visible);
  });
  console.log('Visible buttons in detail view:', JSON.stringify(btns, null, 2));

  process.exit(0);
}

run().catch(console.error);
