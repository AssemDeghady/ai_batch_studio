const { chromium } = require('playwright-core');

async function run() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const context = browser.contexts()[0];
  const chatgptPage = context.pages().find((p) => p.url().includes('chatgpt.com'));

  const dom = await chatgptPage.evaluate(() => {
    // Find all elements with data attributes or classes
    const all = Array.from(document.querySelectorAll('main *'));
    const messageLike = all.filter(el => {
      const cls = (el.className || '').toString();
      const testId = el.getAttribute('data-testid') || '';
      const role = el.getAttribute('data-message-author-role') || '';
      return /message|turn|conversation|assistant|agent/i.test(cls + ' ' + testId + ' ' + role);
    });
    return messageLike.slice(0, 15).map(el => ({
      tagName: el.tagName,
      className: el.className?.slice?.(0, 60),
      testId: el.getAttribute('data-testid'),
      role: el.getAttribute('data-message-author-role'),
      text: el.textContent?.trim().slice(0, 60)
    }));
  });

  console.log('Message-like elements in main:');
  console.log(JSON.stringify(dom, null, 2));
  process.exit(0);
}

run().catch(console.error);
