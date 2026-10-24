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

async function inspectFlow() {
  const targets = await getTargets();
  const flowTarget = targets.find((t) => t.url.includes('flow.google.com'));
  if (!flowTarget) {
    console.log('No Flow target found');
    return;
  }

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
          // Check composers
          const textareas = Array.from(document.querySelectorAll('textarea, [contenteditable="true"]')).map(el => ({
            tag: el.tagName,
            cls: el.className,
            placeholder: el.getAttribute('placeholder') || el.placeholder,
            id: el.id,
            visible: el.offsetWidth > 0 && el.offsetHeight > 0
          }));

          // Check buttons
          const buttons = Array.from(document.querySelectorAll('button')).map(b => ({
            text: b.innerText.trim().slice(0, 40).replace(/\\s+/g, ' '),
            aria: b.getAttribute('aria-label'),
            cls: b.className.slice(0, 50),
            visible: b.offsetWidth > 0 && b.offsetHeight > 0
          })).filter(b => b.visible && (b.text || b.aria));

          // Check current settings chips or badges visible
          const chips = Array.from(document.querySelectorAll('[class*="chip"], [class*="pill"], [class*="badge"], [role="tab"], mat-chip, .mat-mdc-chip')).map(c => ({
            text: c.innerText.trim().replace(/\\s+/g, ' '),
            cls: c.className
          }));

          return {
            title: document.title,
            url: window.location.href,
            textareas,
            buttonsCount: buttons.length,
            buttons: buttons.slice(0, 30),
            chips: chips.slice(0, 20)
          };
        })()`,
        returnByValue: true
      }
    })
  );

  ws.on('message', (msg) => {
    const res = JSON.parse(msg);
    if (res.id === id) {
      console.log('Flow DOM Inspection:');
      console.log(JSON.stringify(res.result.result.value, null, 2));
      ws.close();
      process.exit(0);
    }
  });
}

inspectFlow();
