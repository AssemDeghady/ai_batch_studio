const { chromium } = require('playwright-core');

(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const chatPage = browser.contexts()[0].pages().find((p) => p.url().includes('chatgpt.com'));

  const result = await chatPage.evaluate(() => {
    const turns = Array.from(
      document.querySelectorAll(
        '[data-turn-key], [data-virtualized-turn-content], [data-content-search-turn-key], [data-message-author-role="assistant"], article[data-testid^="conversation-turn-"], .agent-turn'
      )
    );
    return turns.map((t, i) => {
      const imgs = Array.from(t.querySelectorAll('img')).map((img) => ({
        src: img.src.slice(0, 60),
        alt: img.alt,
        previewBtn: Boolean(img.closest('button[data-testid="generated-image-preview"]'))
      }));
      return {
        i,
        tag: t.tagName,
        turnKey: t.getAttribute('data-turn-key'),
        textSnippet: (t.innerText || '').slice(0, 60).replace(/\s+/g, ' '),
        imgs
      };
    });
  });

  console.log('Turns list:');
  console.log(JSON.stringify(result, null, 2));

  await browser.close();
  process.exit(0);
})();
