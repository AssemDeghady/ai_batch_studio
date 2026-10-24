const { chromium } = require('playwright-core');

(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const context = browser.contexts()[0];
  let extPage = context.pages().find((p) =>
    p.url().includes('chrome-extension://pkpgpjlimgpnbggiecpacnmoopnamhhh')
  );
  if (!extPage) {
    extPage = await context.newPage();
    await extPage.goto('chrome-extension://pkpgpjlimgpnbggiecpacnmoopnamhhh/index.html');
    await extPage.waitForTimeout(1000);
  }

  const dbData = await extPage.evaluate(async () => {
    return new Promise((resolve) => {
      const req = indexedDB.open('BatchStudioDB', 1);
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction(['batches', 'tasks', 'outputs', 'diagnostic_logs'], 'readonly');
        const bReq = tx.objectStore('batches').getAll();
        const tReq = tx.objectStore('tasks').getAll();
        const oReq = tx.objectStore('outputs').getAll();
        const lReq = tx.objectStore('diagnostic_logs').getAll();

        tx.oncomplete = () => {
          resolve({
            batches: bReq.result.slice(-2),
            tasks: tReq.result.slice(-5),
            outputs: oReq.result.slice(-5),
            logs: lReq.result.slice(-20)
          });
        };
      };
      req.onerror = (e) => resolve({ error: e.target.error.message });
    });
  });

  console.log('--- RECENT BATCHES ---');
  console.log(JSON.stringify(dbData.batches, null, 2));

  console.log('--- RECENT TASKS ---');
  console.log(JSON.stringify(dbData.tasks, null, 2));

  console.log('--- RECENT OUTPUTS ---');
  console.log(JSON.stringify(dbData.outputs, null, 2));

  console.log('--- RECENT DIAGNOSTIC LOGS ---');
  if (dbData.logs) {
    dbData.logs.forEach((l) => {
      console.log(`[${new Date(l.timestamp).toLocaleTimeString()}] [${l.level.toUpperCase()}] [${l.scope}] ${l.message}`);
    });
  }

  await browser.close();
  process.exit(0);
})();
