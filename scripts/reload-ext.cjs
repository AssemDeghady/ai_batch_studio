const { chromium } = require('playwright-core');

async function reloadExtension() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const context = browser.contexts()[0];

  // Open or find chrome://extensions
  let extManagePage = context.pages().find((p) => p.url().includes('chrome://extensions'));
  let createdManagePage = false;
  if (!extManagePage) {
    extManagePage = await context.newPage();
    await extManagePage.goto('chrome://extensions');
    createdManagePage = true;
  } else {
    await extManagePage.reload();
  }
  await extManagePage.waitForTimeout(600);

  // Click reload on the Batch Studio extension item
  const reloaded = await extManagePage.evaluate(() => {
    const mgr = document.querySelector('extensions-manager');
    const itemList = mgr?.shadowRoot?.querySelector('extensions-item-list');
    const items = Array.from(itemList?.shadowRoot?.querySelectorAll('extensions-item') || []);
    const bsItem = items.find((item) => {
      const name = item.shadowRoot?.querySelector('#name')?.textContent?.trim() || '';
      return name.includes('Batch Studio');
    });
    if (bsItem) {
      const reloadBtn = bsItem.shadowRoot?.querySelector('#dev-reload-button');
      if (reloadBtn) {
        reloadBtn.click();
        return 'Reloaded Batch Studio extension!';
      }
    }
    return 'Could not find reload button';
  });
  console.log('Reload status:', reloaded);

  if (createdManagePage) {
    await extManagePage.close();
  }

  await new Promise((r) => setTimeout(r, 1000));

  // Reload Flow page and Extension page
  const chatgptPage = context.pages().find((p) => p.url().includes('chatgpt.com'));
  if (chatgptPage) {
    console.log('Reloading ChatGPT page...');
    await chatgptPage.reload({ waitUntil: 'domcontentloaded' });
    console.log('ChatGPT page reloaded.');
  }

  const flowPage = context.pages().find((p) => p.url().includes('flow.google.com/project'));
  if (flowPage) {
    console.log('Reloading Google Flow page...');
    await flowPage.reload({ waitUntil: 'networkidle' });
    console.log('Google Flow page reloaded.');
  }

  const extPage = context.pages().find((p) =>
    p.url().includes('chrome-extension://pkpgpjlimgpnbggiecpacnmoopnamhhh')
  );
  if (extPage) {
    console.log('Reloading Extension UI page...');
    await extPage.reload({ waitUntil: 'networkidle' });
    console.log('Extension UI page reloaded.');
  }

  process.exit(0);
}

reloadExtension().catch(console.error);
