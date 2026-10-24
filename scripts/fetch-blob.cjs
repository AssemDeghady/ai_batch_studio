const { chromium } = require('playwright-core');

(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const chatPage = browser.contexts()[0].pages().find((p) => p.url().includes('chatgpt.com'));
  if (!chatPage) {
    console.log('No chat page');
    process.exit(1);
  }

  await chatPage.goto('https://chatgpt.com/c/6adce7dc-07b4-83ea-9c58-657026d2ff80');
  await chatPage.waitForTimeout(2000);

  const results = await chatPage.evaluate(async () => {
    const imgs = Array.from(document.querySelectorAll('img')).filter((i) =>
      i.src.startsWith('blob:')
    );
    const out = [];
    for (const img of imgs) {
      try {
        const res = await fetch(img.src);
        const blob = await res.blob();
        out.push({
          src: img.src,
          size: blob.size,
          type: blob.type
        });
      } catch (e) {
        out.push({ src: img.src, error: e.message });
      }
    }
    return out;
  });

  console.log('Blob details:', JSON.stringify(results, null, 2));

  await browser.close();
  process.exit(0);
})();
