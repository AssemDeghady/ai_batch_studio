const { chromium } = require('playwright-core');

async function run() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const context = browser.contexts()[0];
  const chatgptPage = context.pages().find((p) => p.url().includes('chatgpt.com'));
  const state = await chatgptPage.evaluate(() => {
    const turns = Array.from(document.querySelectorAll('[data-message-author-role="assistant"], article, [data-testid^="conversation-turn-"]')).map(t => t.textContent.slice(0, 100));
    const imgs = Array.from(document.querySelectorAll('img')).map(i => i.src.slice(0, 80));
    const stopBtn = document.querySelector('button[aria-label*="Stop" i], button[data-testid="stop-button"]');
    return {
      turnsCount: turns.length,
      turnsSample: turns.slice(-3),
      imgs,
      hasStopBtn: Boolean(stopBtn)
    };
  });
  console.log(state);
  process.exit(0);
}

run().catch(console.error);
