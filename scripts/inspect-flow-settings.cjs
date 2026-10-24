const WebSocket = require('ws');
const http = require('http');

function getTargets() {
  return new Promise((resolve, reject) => {
    http.get('http://127.0.0.1:9222/json/list', (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => resolve(JSON.parse(data)));
      res.on('error', reject);
    });
  });
}

async function inspectSettings() {
  const targets = await getTargets();
  const flowTarget = targets.find((t) => t.url.includes('flow.google.com'));
  const ws = new WebSocket(flowTarget.webSocketDebuggerUrl);
  await new Promise((r) => ws.on('open', r));

  const id = 1;
  ws.send(
    JSON.stringify({
      id,
      method: 'Runtime.evaluate',
      params: {
        awaitPromise: true,
        expression: `(async () => {
          const btn = document.querySelector('button[aria-label="Settings trigger"], .settings-trigger-button');
          if (btn) btn.click();
          await new Promise(r => setTimeout(r, 600));

          const dialogs = Array.from(document.querySelectorAll('[role="dialog"], [role="menu"], mat-dialog-container, .mat-mdc-menu-panel, .settings-panel')).map(d => ({
            tag: d.tagName,
            cls: d.className,
            text: d.innerText.replace(/\\s+/g, ' ').slice(0, 300)
          }));

          return {
            hasTrigger: Boolean(btn),
            triggerText: btn ? btn.innerText.trim() : null,
            dialogs
          };
        })()`,
        returnByValue: true
      }
    })
  );

  ws.on('message', (msg) => {
    const res = JSON.parse(msg);
    if (res.id === id) {
      console.log('Settings inspection:');
      console.log(JSON.stringify(res.result.result.value, null, 2));
      ws.close();
      process.exit(0);
    }
  });
}

inspectSettings();
