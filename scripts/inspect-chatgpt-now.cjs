const { chromium } = require('playwright-core');

async function run() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const context = browser.contexts()[0];
  const chatgptPage = context.pages().find((p) => p.url().includes('chatgpt.com'));

  const result = await chatgptPage.evaluate(() => {
    const mainText = document.querySelector('main')?.innerText || '';
    const imgs = Array.from(document.querySelectorAll('main img')).map(img => ({
      src: img.src?.slice(0, 100),
      currentSrc: img.currentSrc?.slice(0, 100),
      alt: img.alt,
      width: img.width,
      height: img.height,
      className: img.className
    }));
    const hasStop = Boolean(document.querySelector('button[aria-label*="Stop" i]'));
    return {
      mainTextSample: mainText.slice(0, 500),
      imgs,
      hasStop
    };
  });

  console.log('ChatGPT state now:');
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

run().catch(console.error);
