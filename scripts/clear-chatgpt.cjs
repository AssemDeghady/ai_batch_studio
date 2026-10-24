const { chromium } = require('playwright-core');

async function run() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const context = browser.contexts()[0];
  const chatgptPage = context.pages().find((p) => p.url().includes('chatgpt.com'));
  await chatgptPage.evaluate(() => {
    const composer = document.querySelector('#prompt-textarea, [data-testid="composer-input"], div[contenteditable="true"]');
    if (composer) {
      if (composer.tagName === 'DIV') composer.innerHTML = '<p><br></p>';
      else composer.value = '';
      composer.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true }));
    }
  });
  console.log('Cleared composer');
  process.exit(0);
}

run().catch(console.error);
