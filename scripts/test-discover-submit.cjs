const { chromium } = require('playwright-core');

async function testDiscover() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const context = browser.contexts()[0];
  const flowPage = context.pages().find((p) => p.url().includes('flow.google.com/project'));

  const result = await flowPage.evaluate(() => {
    const genBtn = document.querySelector(
      'button.generate-icon-button, button[aria-label*="Start generation" i]'
    );
    const selectors = [
      '[role="dialog"]',
      '[role="menu"]',
      '[role="listbox"]',
      '[data-popup]',
      '.modal',
      '.dialog',
      '.settings-dialog',
      '.boqOnegoogleliteOgbOneGoogleBar',
      '#gb',
      '.sidenav'
    ];

    const matches = {};
    for (const sel of selectors) {
      const match = genBtn.closest(sel);
      if (match) {
        matches[sel] = {
          tagName: match.tagName,
          className: match.className,
          id: match.id,
          role: match.getAttribute('role')
        };
      }
    }
    return matches;
  });

  console.log('Matched ancestors:', JSON.stringify(result, null, 2));
  process.exit(0);
}

testDiscover().catch(console.error);
