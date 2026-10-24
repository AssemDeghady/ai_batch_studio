const { chromium } = require('playwright-core');

(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const chatPage = browser.contexts()[0].pages().find((p) => p.url().includes('chatgpt.com'));
  if (!chatPage) {
    console.log('No chat page');
    process.exit(1);
  }

  await chatPage.click('button[aria-label="Send"], [data-testid="send-button"]');
  console.log('Clicked Send button in ChatGPT tab!');
  await chatPage.waitForTimeout(2000);
  const info = await chatPage.evaluate(() => {
    const stopBtn = document.querySelector('button[aria-label*="Stop" i], [data-testid="stop-button"]');
    const composer = document.querySelector('#prompt-textarea');
    return {
      hasStopBtn: Boolean(stopBtn),
      composerText: composer ? composer.innerText : null
    };
  });
  console.log('After click:', info);
  await browser.close();
  process.exit(0);
})();
