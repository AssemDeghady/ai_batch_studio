const WebSocket = require('ws');

const ws = new WebSocket('ws://127.0.0.1:9222/devtools/page/8D9569D28A0D09566ABA9478EC6B14A8');

ws.on('open', () => {
  ws.send(
    JSON.stringify({
      id: 1,
      method: 'Runtime.evaluate',
      params: {
        awaitPromise: true,
        expression: `(() => {
          const modals = Array.from(document.querySelectorAll('[role="dialog"], [aria-modal="true"], .fixed, .absolute')).map(el => ({
            tag: el.tagName,
            role: el.getAttribute('role'),
            className: el.className.slice(0, 50),
            visible: el.offsetWidth > 0 && el.offsetHeight > 0,
            text: el.innerText ? el.innerText.slice(0, 100) : ''
          })).filter(m => m.visible && m.text.length > 5);

          const previewBtns = Array.from(document.querySelectorAll('button[data-testid="generated-image-preview"]')).map((b, i) => {
            const r = b.getBoundingClientRect();
            return {
              i,
              x: Math.round(r.left + r.width/2),
              y: Math.round(r.top + r.height/2),
              w: Math.round(r.width),
              h: Math.round(r.height),
              visible: b.offsetWidth > 0 && b.offsetHeight > 0
            };
          });

          return { modals, previewBtns };
        })()`,
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
