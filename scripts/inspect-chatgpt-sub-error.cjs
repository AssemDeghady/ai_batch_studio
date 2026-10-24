const { chromium } = require('playwright-core');

async function run() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const context = browser.contexts()[0];
  const extPage = context.pages().find((p) => p.url().includes('chrome-extension://pkpgpjlimgpnbggiecpacnmoopnamhhh'));

  const details = await extPage.evaluate(async () => {
    return await new Promise((resolve) => {
      const req = indexedDB.open('BatchStudioDB', 1);
      req.onsuccess = (e) => {
        const db = e.target.result;
        const tx = db.transaction(['tasks', 'diagnostic_logs'], 'readonly');
        const tasksReq = tx.objectStore('tasks').getAll();
        const logsReq = tx.objectStore('diagnostic_logs').getAll();

        let tasks = [];
        let logs = [];
        tasksReq.onsuccess = () => { tasks = tasksReq.result; };
        logsReq.onsuccess = () => { logs = logsReq.result; };

        tx.oncomplete = () => {
          resolve({
            lastTask: tasks[tasks.length - 1],
            recentLogs: logs.slice(-10)
          });
        };
      };
      req.onerror = (e) => resolve({ error: e });
    });
  });

  console.log('Task Details:', JSON.stringify(details, null, 2));
  process.exit(0);
}

run().catch(console.error);
