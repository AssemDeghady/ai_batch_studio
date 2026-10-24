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

async function inspect() {
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
        expression: `(() => {
          const turns = Array.from(document.querySelectorAll('[data-turn-key]'));
          return turns.map((t, i) => {
            const imgs = Array.from(t.querySelectorAll('img')).map(img => ({
              src: img.src.slice(0, 80),
              alt: img.alt,
              w: img.width,
              h: img.height
            }));
            const stopBtn = document.querySelector('button[aria-label*="Stop" i], [data-testid="stop-button"]');
            return {
              i,
              turnKey: t.getAttribute('data-turn-key'),
              textSnippet: t.innerText.slice(0, 150).replace(/\\n+/g, ' '),
              imgsCount: imgs.length,
              imgs,
              hasStopBtn: Boolean(stopBtn)
            };
          });
        })()`,
        returnByValue: true
      }
    })
  );

  ws.on('message', (msg) => {
    const res = JSON.parse(msg);
    if (res.id === id) {
      console.log('Turns inspection:');
      console.log(JSON.stringify(res.result.result.value, null, 2));
      ws.close();
      process.exit(0);
    }
  });
}

inspect();
