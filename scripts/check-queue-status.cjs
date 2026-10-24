const { chromium } = require('playwright-core');

async function run() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const context = browser.contexts()[0];
  const extPage = context.pages().find((p) => p.url().includes('chrome-extension://pkpgpjlimgpnbggiecpacnmoopnamhhh'));
  const status = await extPage.evaluate(() => {
    const text = document.body.innerText;
    const chips = Array.from(document.querySelectorAll('.status-chip, .badge, [class*="status"]')).map(c => c.textContent.trim());
    return { chips, text: text.slice(0, 300).replace(/\n+/g, ' ') };
  });
  console.log('Current Extension UI Status:', status);
  process.exit(0);
}

run().catch(console.error);
