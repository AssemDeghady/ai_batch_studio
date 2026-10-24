const { chromium } = require('playwright-core');

(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const chatPage = browser.contexts()[0].pages().find((p) => p.url().includes('chatgpt.com'));
  if (!chatPage) {
    console.log('No chat page');
    process.exit(1);
  }

  const details = await chatPage.evaluate(() => {
    const turns = Array.from(document.querySelectorAll('[data-turn-key]'));
    return turns.map((t, idx) => {
      const promptEl = t.querySelector('.whitespace-pre-wrap, [class*="user"], div');
      const text = t.innerText;
      return {
        idx,
        key: t.getAttribute('data-turn-key'),
        fullText: text.slice(0, 300)
      };
    });
  });

  console.log('ChatGPT Turns:');
  console.log(JSON.stringify(details, null, 2));

  await browser.close();
  process.exit(0);
})();
