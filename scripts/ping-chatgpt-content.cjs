const { chromium } = require('playwright-core');

async function run() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const chatgptPage = browser.contexts()[0].pages().find((p) => p.url().includes('chatgpt.com'));

  // Reload the ChatGPT page once to ensure the extension content script is injected!
  console.log('Reloading ChatGPT page to ensure content script is injected...');
  await chatgptPage.reload({ waitUntil: 'domcontentloaded' });
  await chatgptPage.waitForTimeout(2000);

  // Check if content script listener is active
  const hasScript = await chatgptPage.evaluate(() => {
    return {
      hasWinListener: Boolean(window.__BATCH_STUDIO_MESSAGE_LISTENER__),
      url: window.location.href,
      readyState: document.readyState
    };
  });
  console.log('Content script state on ChatGPT:', hasScript);

  process.exit(0);
}

run().catch(console.error);
