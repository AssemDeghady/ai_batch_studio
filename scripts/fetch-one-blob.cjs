const { chromium } = require('playwright-core');

(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const chatPage = browser.contexts()[0].pages().find((p) => p.url().includes('chatgpt.com'));

  const blobInfo = await chatPage.evaluate(async () => {
    const img = document.querySelector('img[src^="blob:"]');
    if (!img) return { error: 'No blob img' };
    try {
      const res = await fetch(img.src);
      const b = await res.blob();
      return {
        src: img.src,
        size: b.size,
        type: b.type
      };
    } catch (e) {
      return { error: e.message };
    }
  });

  console.log('Blob fetched directly:', blobInfo);

  await browser.close();
  process.exit(0);
})();
