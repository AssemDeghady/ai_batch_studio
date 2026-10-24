const { chromium } = require('playwright-core');

async function readDB() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const context = browser.contexts()[0];
  const extPage = context.pages().find((p) =>
    p.url().includes('chrome-extension://pkpgpjlimgpnbggiecpacnmoopnamhhh')
  );

  const data = await extPage.evaluate(async () => {
    return await new Promise((resolve) => {
      const req = indexedDB.open('BatchStudioDB', 1);
      req.onsuccess = (e) => {
        const db = e.target.result;
        const tx = db.transaction(['tasks', 'diagnostic_logs'], 'readonly');
        const tasksReq = tx.objectStore('tasks').getAll();
        const logsReq = tx.objectStore('diagnostic_logs').getAll();
        tx.oncomplete = () => {
          const tasks = tasksReq.result;
          const logs = logsReq.result;
          const lastTask = tasks[tasks.length - 1];
          const recentLogs = logs.slice(-10);
          resolve({
            taskStatus: lastTask?.status,
            friendlyStatus: lastTask?.friendlyStatus,
            lastError: lastTask?.lastError,
            recentLogs: recentLogs.map((l) => ({
              scope: l.scope,
              level: l.level,
              message: l.message
            }))
          });
        };
      };
      req.onerror = () => resolve('error opening db');
    });
  });

  console.log(JSON.stringify(data, null, 2));
  process.exit(0);
}

readDB().catch(console.error);
