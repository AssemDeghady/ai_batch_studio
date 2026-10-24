const { chromium } = require('playwright-core');

async function run() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const context = browser.contexts()[0];
  const flowPage = context.pages().find((p) => p.url().includes('flow.google.com/project'));

  await flowPage.evaluate(() => {
    const origClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function() {
      console.log('HOOKED ANCHOR CLICK:', {
        href: this.href?.slice(0, 80),
        download: this.download
      });
      window.__last_anchor_download = { href: this.href, download: this.download };
      return origClick.apply(this, arguments);
    };
  });

  // Click on the first image on Flow page
  await flowPage.bringToFront();
  const img = await flowPage.$('img[src*="flow-content.google"]');
  if (img) {
    console.log('Clicking image tile...');
    await img.click();
    await flowPage.waitForTimeout(1000);
  }

  // Click Download button
  const dlBtn = await flowPage.$('button[aria-label*="Download" i], button[title*="Download" i]');
  if (dlBtn) {
    console.log('Clicking Download button...');
    await dlBtn.click();
    await flowPage.waitForTimeout(500);
  }

  // Click 1K Original Size
  const origBtn = await flowPage.$('[role="menuitem"]:has-text("Original size"), button:has-text("Original size")');
  console.log('origBtn found?', Boolean(origBtn));
  if (origBtn) {
    console.log('Clicking 1K Original size...');
    await origBtn.click();
    await flowPage.waitForTimeout(1000);
  }

  const anchor = await flowPage.evaluate(() => window.__last_anchor_download);
  console.log('Anchor captured:', anchor);
  process.exit(0);
}

run().catch(console.error);
