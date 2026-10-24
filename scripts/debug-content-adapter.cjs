const { chromium } = require('playwright-core');

async function debugContentAdapter() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const context = browser.contexts()[0];
  const flowPage = context.pages().find((p) => p.url().includes('flow.google.com/project'));

  // Listen to console messages on flowPage
  flowPage.on('console', (msg) => console.log('FLOW PAGE CONSOLE:', msg.text()));

  const res = await flowPage.evaluate(async () => {
    // Run exactly what handleContentScriptMessage runs
    // @ts-ignore
    const adapter = window.__bs_flow_adapter;
    console.log('window.__bs_flow_adapter exists?', Boolean(adapter));

    // Let's call the message listener directly
    return await new Promise((resolve) => {
      chrome.runtime.onMessage.dispatch(
        {
          type: 'BS_ADAPTER_GET_TASK_STATUS',
          platformId: 'google_flow',
          task: {
            id: 'task_batch_1792856028236_2l58rf_1',
            taskType: 'image',
            generationSettings: { outputCount: 1 }
          }
        },
        {},
        (resp) => resolve(resp)
      );
    });
  });

  console.log('Result from dispatch:', res);
  process.exit(0);
}

debugContentAdapter().catch(console.error);
