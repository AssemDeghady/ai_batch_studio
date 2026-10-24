const { chromium } = require('playwright-core');

async function run() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const context = browser.contexts()[0];
  const extPage = context.pages().find((p) => p.url().includes('chrome-extension://pkpgpjlimgpnbggiecpacnmoopnamhhh'));
  const flowPage = context.pages().find((p) => p.url().includes('flow.google.com/project'));

  const imgSrc = await flowPage.evaluate(() => {
    const img = document.querySelector('aisandbox-root img[src*="flow-content.google"]');
    return img ? img.src : null;
  });
  console.log('imgSrc:', imgSrc);

  if (!imgSrc) {
    console.log('No img found');
    process.exit(1);
  }

  const dlResult = await extPage.evaluate(async (url) => {
    try {
      const id = await chrome.downloads.download({
        url: url,
        filename: 'DirectDownloadTest_Phoenix.jpg',
        conflictAction: 'uniquify'
      });
      return { ok: true, id };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }, imgSrc);

  console.log('dlResult:', dlResult);
  process.exit(0);
}

run().catch(console.error);
