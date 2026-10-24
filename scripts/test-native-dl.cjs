const { chromium } = require('playwright-core');

async function run() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const context = browser.contexts()[0];
  const flowPage = context.pages().find((p) => p.url().includes('flow.google.com/project'));
  const extPage = context.pages().find((p) => p.url().includes('chrome-extension://pkpgpjlimgpnbggiecpacnmoopnamhhh'));

  // Reset CDP download behavior so CDP doesn't hijack downloads to temp
  const client = await flowPage.context().newCDPSession(flowPage);
  await client.send('Page.setDownloadBehavior', { behavior: 'default' });
  const browserClient = await browser.newBrowserCDPSession();
  try {
    await browserClient.send('Browser.setDownloadBehavior', { behavior: 'default' });
  } catch (e) {
    console.log('Browser.setDownloadBehavior default:', e.message);
  }

  // Open detail view on first image
  await flowPage.bringToFront();
  const firstImg = await flowPage.$('aisandbox-root img[src*="flow-content.google"]');
  if (firstImg) {
    await firstImg.click();
    await flowPage.waitForTimeout(1000);
  }

  // Click Download button
  const dlBtn = await flowPage.$('button[aria-label*="Download" i], button[title*="Download" i]');
  if (dlBtn) {
    await dlBtn.click();
    await flowPage.waitForTimeout(500);
  }

  // Click 1K Original Size
  const origBtn = await flowPage.$('button:has-text("Original size"), [role="menuitem"]:has-text("Original size"), div:has-text("1K")');
  console.log('Original size button found?', Boolean(origBtn));
  if (origBtn) {
    await origBtn.click();
    console.log('Clicked 1K Original size!');
    await flowPage.waitForTimeout(3000);
  }

  // Check chrome.downloads in extension
  const downloads = await extPage.evaluate(async () => {
    const list = await chrome.downloads.search({ limit: 3 });
    return list.map(d => ({
      id: d.id,
      filename: d.filename,
      mime: d.mime,
      state: d.state,
      fileSize: d.fileSize
    }));
  });
  console.log('Recent chrome downloads:', JSON.stringify(downloads, null, 2));
  process.exit(0);
}

run().catch(console.error);
