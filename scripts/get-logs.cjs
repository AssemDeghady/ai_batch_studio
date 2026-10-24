const { chromium } = require('playwright-core');

(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const extPage = browser.contexts()[0].pages().find((p) =>
    p.url().includes('chrome-extension://pkpgpjlimgpnbggiecpacnmoopnamhhh')
  );
  if (!extPage) {
    console.log('No ext page');
    process.exit(1);
  }

  const result = await extPage.evaluate(async () => {
    return new Promise((resolve) => {
      const req = indexedDB.open('BatchStudioDB', 1);
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction(['diagnostic_logs', 'tasks'], 'readonly');
        const logsStore = tx.objectStore('diagnostic_logs');
        const tasksStore = tx.objectStore('tasks');

        const logsReq = logsStore.getAll();
        logsReq.onsuccess = () => {
          const tasksReq = tasksStore.getAll();
          tasksReq.onsuccess = () => {
            resolve({
              logs: logsReq.result.slice(-25),
              tasks: tasksReq.result.slice(-5)
            });
          };
        };
      };
      req.onerror = (e) => resolve({ error: e.target.error.message });
    });
  });

  console.log('--- RECENT TASKS ---');
  console.log(JSON.stringify(result.tasks, null, 2));

  console.log('--- RECENT DIAGNOSTIC LOGS ---');
  if (result.logs) {
    result.logs.forEach((l) => {
      console.log(`[${new Date(l.timestamp).toLocaleTimeString()}] [${l.level.toUpperCase()}] [${l.scope}] ${l.message}`);
    });
  }
  await browser.close();
  process.exit(0);
})();
