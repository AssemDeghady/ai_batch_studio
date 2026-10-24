const { chromium } = require('playwright-core');

async function inspectError() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const context = browser.contexts()[0];
  const extPage = context.pages().find((p) =>
    p.url().includes('chrome-extension://pkpgpjlimgpnbggiecpacnmoopnamhhh')
  );

  const text = await extPage.evaluate(() => document.body.innerText);
  console.log('--- EXTENSION PAGE FULL TEXT ---');
  console.log(text);
  console.log('--------------------------------');

  process.exit(0);
}

inspectError().catch(console.error);
