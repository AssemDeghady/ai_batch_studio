const WebSocket = require('ws');

const ws = new WebSocket('ws://127.0.0.1:9222/devtools/page/9D8E39FA0D743CFD3FD49391A9049DE6');

ws.on('open', () => {
  ws.send(
    JSON.stringify({
      id: 1,
      method: 'Runtime.evaluate',
      params: {
        awaitPromise: true,
        expression: `
          new Promise((resolve) => {
            const req = window.indexedDB.open('BatchStudioDB', 1);
            req.onsuccess = () => {
              const db = req.result;
              const tx = db.transaction(['tasks', 'outputs', 'batches'], 'readonly');
              const tReq = tx.objectStore('tasks').getAll();
              const oReq = tx.objectStore('outputs').getAll();
              const bReq = tx.objectStore('batches').getAll();
              tx.oncomplete = () => {
                resolve({
                  batches: bReq.result.map((b) => ({
                    id: b.id,
                    name: b.name,
                    platform: b.platform,
                    status: b.status,
                    taskIds: b.taskIds
                  })),
                  tasks: tReq.result.map((t) => ({
                    id: t.id,
                    batchId: t.batchId,
                    status: t.status,
                    friendlyStatus: t.friendlyStatus,
                    error: t.error,
                    outputIds: t.outputIds,
                    updatedAt: new Date(t.updatedAt).toLocaleTimeString()
                  })),
                  outputs: oReq.result.map((o) => ({
                    id: o.id,
                    filename: o.filename,
                    status: o.status,
                    error: o.error
                  }))
                });
              };
            };
            req.onerror = () => resolve({ error: 'DB open failed' });
          })
        `,
        returnByValue: true
      }
    })
  );
});

ws.on('message', (data) => {
  const res = JSON.parse(data);
  if (res.id === 1) {
    console.log(JSON.stringify(res.result.result.value, null, 2));
    ws.close();
    process.exit(0);
  }
});
