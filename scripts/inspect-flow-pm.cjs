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

async function inspectProseMirror() {
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
        expression: `(() => {
          const pm = document.querySelector('div.ProseMirror');
          const genBtn = document.querySelector('button[aria-label="Start generation"], button.generate-icon-button, button.flow-icon-button-secondary');
          const trigger = document.querySelector('button[aria-label="Settings trigger"], .settings-trigger-button');

          return {
            hasPM: Boolean(pm),
            pmHTML: pm ? pm.innerHTML : null,
            pmText: pm ? pm.innerText : null,
            hasGenBtn: Boolean(genBtn),
            genBtnAria: genBtn ? genBtn.getAttribute('aria-label') : null,
            genBtnDisabled: genBtn ? genBtn.disabled : null,
            triggerText: trigger ? trigger.innerText.trim().replace(/\\s+/g, ' ') : null
          };
        })()`,
        returnByValue: true
      }
    })
  );

  ws.on('message', (msg) => {
    const res = JSON.parse(msg);
    if (res.id === id) {
      console.log('ProseMirror & Button State:');
      console.log(JSON.stringify(res.result.result.value, null, 2));
      ws.close();
      process.exit(0);
    }
  });
}

inspectProseMirror();
