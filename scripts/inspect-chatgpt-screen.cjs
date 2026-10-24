const WebSocket = require('ws');

const ws = new WebSocket('ws://127.0.0.1:9222/devtools/page/8D9569D28A0D09566ABA9478EC6B14A8');

ws.on('open', () => {
  ws.send(
    JSON.stringify({
      id: 1,
      method: 'Runtime.evaluate',
      params: {
        expression: `(() => {
          return {
            url: window.location.href,
            bodyText: document.body.innerText.slice(0, 500).replace(/\\s+/g, ' ')
          };
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
