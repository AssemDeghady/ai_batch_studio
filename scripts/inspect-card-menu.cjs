const { chromium } = require('playwright-core');

async function run() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const context = browser.contexts()[0];
  const flowPage = context.pages().find((p) => p.url().includes('flow.google.com/project'));
  await flowPage.bringToFront();

  // Find card more_vert
  const moreVert = await flowPage.$('button[aria-label="More options"]');
  if (moreVert) {
    await moreVert.click();
    await flowPage.waitForTimeout(500);
    const menuItems = await flowPage.evaluate(() => {
      return Array.from(document.querySelectorAll('[role="menuitem"], .mat-mdc-menu-item')).map(m => m.textContent.trim()).filter(Boolean);
    });
    console.log('Menu items after clicking more_vert on card:', menuItems);
  }
  process.exit(0);
}

run().catch(console.error);
