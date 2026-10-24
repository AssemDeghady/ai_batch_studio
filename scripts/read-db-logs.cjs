const { chromium } = require('playwright-core');

async function readLogs() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const context = browser.contexts()[0];
  const extPage = context.pages().find((p) =>
    p.url().includes('chrome-extension://pkpgpjlimgpnbggiecpacnmoopnamhhh')
  );

  const logs = await extPage.evaluate(async () => {
    return await new Promise((resolve) => {
      const req = indexedDB.open('BatchStudioDB', 1);
      req.onsuccess = (e) => {
        const db = e.target.result;
        const tx = db.transaction('diagnostic_logs', 'readonly');
        const getReq = tx.objectStore('diagnostic_logs').getAll();
        getReq.onsuccess = () => {
          resolve(getReq.result.slice(-25));
        };
        getReq.onerror = () => resolve([]);
      };
      req.onerror = () => resolve([]);
    });
  });

  console.log('--- RECENT 25 DIAGNOSTIC LOGS ---');
  for (const log of logs) {
    console.log(`[${log.scope}] [${log.level}] ${log.message}`);
  }
  process.exit(0);
}

readLogs().catch(console.error);
