const { chromium } = require('playwright-core');

async function run() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const context = browser.contexts()[0];
  const chatgptPage = context.pages().find((p) => p.url().includes('chatgpt.com'));

  const turns = await chatgptPage.evaluate(() => {
    const turnEls = Array.from(document.querySelectorAll('[data-turn-key], [data-virtualized-turn-content], [data-content-search-turn-key], [class*="group/user-message"], [data-testid="generated-image-gallery"]'));
    return turnEls.map(t => ({
      tagName: t.tagName,
      className: t.className?.slice(0, 50),
      turnKey: t.getAttribute('data-turn-key'),
      hasUserMsg: Boolean(t.querySelector('[class*="user-message"]') || t.className?.includes('user-message')),
      hasAssistantText: t.textContent?.includes('ChatGPT said:') || Boolean(t.querySelector('[data-testid="generated-image-gallery"]')),
      hasImages: t.querySelectorAll('img[alt*="Generated"]').length
    }));
  });

  console.log('Detected turns:', turns);
  process.exit(0);
}

run().catch(console.error);
