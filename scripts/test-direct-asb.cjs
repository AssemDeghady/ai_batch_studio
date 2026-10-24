const { chromium } = require('playwright-core');

async function run() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const context = browser.contexts()[0];
  const extPage = context.pages().find((p) => p.url().includes('chrome-extension://pkpgpjlimgpnbggiecpacnmoopnamhhh'));

  const url = 'https://flow.google.com/asb/ANqvLOZ5VF0sXas4NCjDNkucr7zlixXJoisJfDsYRS8SRPRxiENz44MVKSn_2trOj_lY1D29';

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
  }, url);

  console.log('dlResult:', dlResult);
  process.exit(0);
}

run().catch(console.error);
