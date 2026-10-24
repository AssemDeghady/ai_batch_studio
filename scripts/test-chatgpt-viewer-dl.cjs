const { chromium } = require('playwright-core');

async function run() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const context = browser.contexts()[0];
  const chatgptPage = context.pages().find((p) => p.url().includes('chatgpt.com'));

  // Click the official Download button in the viewer
  console.log('Clicking Download button in ChatGPT viewer...');
  await chatgptPage.click('button[aria-label="Download"]');
  await chatgptPage.waitForTimeout(2000);

  // Close viewer
  const closeBtn = await chatgptPage.$('button[aria-label="Close viewer"]');
  if (closeBtn) {
    console.log('Closing viewer...');
    await closeBtn.click();
  }

  process.exit(0);
}

run().catch(console.error);
