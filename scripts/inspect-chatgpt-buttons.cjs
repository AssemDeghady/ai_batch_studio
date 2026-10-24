const { chromium } = require('playwright-core');

async function run() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const context = browser.contexts()[0];
  const chatgptPage = context.pages().find((p) => p.url().includes('chatgpt.com'));

  const buttons = await chatgptPage.evaluate(() => {
    return Array.from(document.querySelectorAll('button')).map((b) => ({
      tagName: b.tagName,
      id: b.id,
      className: b.className,
      aria: b.getAttribute('aria-label'),
      testId: b.getAttribute('data-testid'),
      disabled: b.disabled,
      text: b.textContent?.trim().slice(0, 30),
      rect: b.getBoundingClientRect()
    })).filter(b => b.rect.width > 0 && b.rect.height > 0);
  });

  console.log('Visible buttons on ChatGPT:');
  console.log(JSON.stringify(buttons, null, 2));
  process.exit(0);
}

run().catch(console.error);
