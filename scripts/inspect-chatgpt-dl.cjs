const { chromium } = require('playwright-core');

async function run() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const context = browser.contexts()[0];
  const chatgptPage = context.pages().find((p) => p.url().includes('chatgpt.com'));

  const buttons = await chatgptPage.evaluate(() => {
    const gallery = document.querySelector('[data-testid="generated-image-gallery"]');
    if (!gallery) return 'No gallery';
    // Check all buttons inside or near gallery
    const turn = gallery.closest('[data-turn-key]') || gallery.parentElement;
    const btns = Array.from(turn.querySelectorAll('button, a')).map(b => ({
      tagName: b.tagName,
      aria: b.getAttribute('aria-label'),
      testId: b.getAttribute('data-testid'),
      text: b.textContent.trim(),
      download: b.getAttribute('download'),
      href: b.getAttribute('href')
    }));
    return btns;
  });

  console.log('Buttons near image gallery:');
  console.log(JSON.stringify(buttons, null, 2));
  process.exit(0);
}

run().catch(console.error);
