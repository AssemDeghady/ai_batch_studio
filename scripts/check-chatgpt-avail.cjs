const { chromium } = require('playwright-core');

async function run() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const context = browser.contexts()[0];
  const chatgptPage = context.pages().find((p) => p.url().includes('chatgpt.com'));
  const extPage = context.pages().find((p) => p.url().includes('chrome-extension://pkpgpjlimgpnbggiecpacnmoopnamhhh'));

  const result = await extPage.evaluate(async () => {
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

  console.log('ChatGPT Availability from Extension:', JSON.stringify(result, null, 2));
  process.exit(0);
}

run().catch(console.error);
