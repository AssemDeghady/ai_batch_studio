const { chromium } = require('playwright-core');

(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const chatPage = browser.contexts()[0].pages().find((p) => p.url().includes('chatgpt.com'));

  const imgs = await chatPage.evaluate(() => {
    return Array.from(document.querySelectorAll('img')).map((i) => ({
      src: i.src,
      alt: i.alt,
      width: i.width,
      height: i.height
    }));
  });

  console.log('All images on conversation page:');
  console.log(JSON.stringify(imgs, null, 2));

  await browser.close();
  process.exit(0);
})();
