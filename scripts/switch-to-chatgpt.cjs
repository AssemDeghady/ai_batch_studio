const { chromium } = require('playwright-core');

async function run() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const context = browser.contexts()[0];
  const extPage = context.pages().find((p) => p.url().includes('chrome-extension://pkpgpjlimgpnbggiecpacnmoopnamhhh'));

  if (!extPage) {
    console.log('Opening extension tab...');
    const page = await context.newPage();
    await page.goto('chrome-extension://pkpgpjlimgpnbggiecpacnmoopnamhhh/index.html');
  } else {
    await extPage.bringToFront();
    // Switch platform selector to ChatGPT
    await extPage.click('button:has-text("Batch Setup")');
    await extPage.waitForTimeout(300);
    await extPage.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      const chatBtn = buttons.find(b => b.textContent.includes('ChatGPT') && !b.textContent.includes('Google Flow'));
      if (chatBtn) chatBtn.click();
    });
    console.log('Switched Batch Studio extension to ChatGPT platform!');
  }
  process.exit(0);
}

run().catch(console.error);
