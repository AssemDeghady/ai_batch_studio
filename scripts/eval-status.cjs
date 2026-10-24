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

async function testGetStatus() {
  const targets = await getTargets();
  const chatTarget = targets.find((t) => t.url.includes('chatgpt.com'));
  const ws = new WebSocket(chatTarget.webSocketDebuggerUrl);
  await new Promise((r) => ws.on('open', r));

  const id = 1;
  ws.send(
    JSON.stringify({
      id,
      method: 'Runtime.evaluate',
      params: {
        awaitPromise: true,
        expression: `(() => {
          const busy = Array.from(document.querySelectorAll('[aria-busy="true"]')).map(el => ({
            tag: el.tagName,
            aria: el.getAttribute('aria-label'),
            cls: el.className
          }));
          const stopBtn = document.querySelector('button[aria-label*="Stop" i], [data-testid="stop-button"]');
          const flowLoader = document.querySelectorAll('.flow-loader, [data-testid="image-gen-loading"], .dalle-progress');

          return {
            busyCount: busy.length,
            busyElements: busy,
            hasStopBtn: Boolean(stopBtn),
            stopBtnAria: stopBtn ? stopBtn.getAttribute('aria-label') : null,
            flowLoaderCount: flowLoader.length
          };
        })()`,
        returnByValue: true
      }
    })
  );

  ws.on('message', (msg) => {
    const res = JSON.parse(msg);
    if (res.id === id) {
      console.log('Inspection:', JSON.stringify(res.result.result.value, null, 2));
      ws.close();
      process.exit(0);
    }
  });
}

testGetStatus();
