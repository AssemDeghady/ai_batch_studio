const { chromium } = require('playwright-core');

async function run() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const context = browser.contexts()[0];
  const chatgptPage = context.pages().find((p) => p.url().includes('chatgpt.com'));

  const tree = await chatgptPage.evaluate(() => {
    const img = document.querySelector('img[alt*="Generated"]');
    if (!img) return 'No img found';
    const chain = [];
    let cur = img.parentElement;
    while (cur && cur !== document.body) {
      chain.push({
        tagName: cur.tagName,
        className: (cur.className || '').toString().slice(0, 80),
        testId: cur.getAttribute('data-testid'),
        role: cur.getAttribute('data-message-author-role'),
        attrs: Array.from(cur.attributes).map(a => `${a.name}="${a.value.slice(0, 40)}"`)
      });
      cur = cur.parentElement;
    }
    return chain;
  });

  console.log('Ancestors of generated image:');
  console.log(JSON.stringify(tree, null, 2));
  process.exit(0);
}

run().catch(console.error);
