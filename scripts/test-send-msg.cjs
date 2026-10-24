const { chromium } = require('playwright-core');

async function testSendMsg() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const context = browser.contexts()[0];
  const extPage = context.pages().find((p) =>
    p.url().includes('chrome-extension://pkpgpjlimgpnbggiecpacnmoopnamhhh')
  );

  const res = await extPage.evaluate(async () => {
    // Send message through chrome.tabs to Flow tab
    const tabs = await chrome.tabs.query({});
    const flowTab = tabs.find((t) => t.url?.includes('flow.google.com/project'));
    if (!flowTab || !flowTab.id) return 'Flow tab not found';

    try {
      const resp = await chrome.tabs.sendMessage(flowTab.id, {
        type: 'BS_ADAPTER_GET_TASK_STATUS',
        platformId: 'google_flow',
        task: {
          id: 'task_batch_1792856028236_2l58rf_1',
          taskType: 'image',
          generationSettings: { outputCount: 1 }
        }
      });
      return { ok: true, resp };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  console.log('Direct status message response:', JSON.stringify(res, null, 2));
  process.exit(0);
}

testSendMsg().catch(console.error);
