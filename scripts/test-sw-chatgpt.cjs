const { chromium } = require('playwright-core');

async function run() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const context = browser.contexts()[0];

  // Open the extension tab so user and we can use it
  let extPage = context.pages().find((p) => p.url().includes('chrome-extension://pkpgpjlimgpnbggiecpacnmoopnamhhh'));
  if (!extPage) {
    extPage = await context.newPage();
    await extPage.goto('chrome-extension://pkpgpjlimgpnbggiecpacnmoopnamhhh/index.html');
    await extPage.waitForTimeout(1000);
  }

  // Ping ChatGPT tab via chrome.tabs.sendMessage
  const pingRes = await extPage.evaluate(async () => {
    const tabs = await chrome.tabs.query({});
    const chatTab = tabs.find((t) => t.url?.includes('chatgpt.com'));
    if (!chatTab || !chatTab.id) return { error: 'ChatGPT tab not found in chrome.tabs' };

    try {
      const resp = await chrome.tabs.sendMessage(chatTab.id, {
        type: 'BS_PING',
        platformId: 'chatgpt'
      });
      return { ok: true, resp, tabId: chatTab.id, tabUrl: chatTab.url };
    } catch (e) {
      return { ok: false, error: e.message, tabId: chatTab.id, tabUrl: chatTab.url };
    }
  });

  console.log('Ping to ChatGPT tab result:', JSON.stringify(pingRes, null, 2));

  // Now check platform availability
  const availRes = await extPage.evaluate(async () => {
    const tabs = await chrome.tabs.query({});
    const chatTab = tabs.find((t) => t.url?.includes('chatgpt.com'));
    if (!chatTab || !chatTab.id) return { error: 'ChatGPT tab not found' };

    try {
      const resp = await chrome.tabs.sendMessage(chatTab.id, {
        type: 'BS_ADAPTER_CHECK_AVAILABILITY',
        platformId: 'chatgpt',
        taskType: 'image'
      });
      return { ok: true, resp };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  console.log('ChatGPT checkAvailability result:', JSON.stringify(availRes, null, 2));
  process.exit(0);
}

run().catch(console.error);
