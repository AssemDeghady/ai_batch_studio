const { chromium } = require('playwright-core');

async function run() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const context = browser.contexts()[0];
  const chatgptPage = context.pages().find((p) => p.url().includes('chatgpt.com'));

  const status = await chatgptPage.evaluate(() => {
    const composer = document.querySelector('#prompt-textarea, [data-testid="composer-input"], div[contenteditable="true"]');
    const sendBtn = document.querySelector('button[data-testid="send-button"], button[aria-label*="Send" i]');
    const activeTask = document.body.getAttribute('data-batch-studio-active-task');
    return {
      activeTask,
      composerText: composer ? composer.textContent : null,
      composerHtml: composer ? composer.innerHTML.slice(0, 100) : null,
      sendBtnFound: Boolean(sendBtn),
      sendBtnAria: sendBtn?.getAttribute('aria-label')
    };
  });

  console.log('ChatGPT state:', status);
  process.exit(0);
}

run().catch(console.error);
