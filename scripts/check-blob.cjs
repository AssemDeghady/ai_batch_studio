const WebSocket = require('ws');

// Connect to ChatGPT tab
const ws = new WebSocket('ws://127.0.0.1:9222/devtools/page/8D9569D28A0D09566ABA9478EC6B14A8');

ws.on('open', () => {
  ws.send(
    JSON.stringify({
      id: 1,
      method: 'Runtime.evaluate',
      params: {
        awaitPromise: true,
        expression: `(async () => {
          // Navigate to the conversation URL
          window.location.href = 'https://chatgpt.com/c/6adce7dc-07b4-83ea-9c58-657026d2ff80';
          await new Promise(r => setTimeout(r, 2000));

          const imgs = Array.from(document.querySelectorAll('img')).filter(i => i.src.startsWith('blob:'));
          if (imgs.length === 0) return { error: 'No blob imgs found' };

          const results = [];
          for (const img of imgs) {
            try {
              const res = await fetch(img.src);
              const blob = await res.blob();
              results.push({
                src: img.src,
                size: blob.size,
                type: blob.type
              });
            } catch (err) {
              results.push({ src: img.src, error: err.message });
            }
          }
          return { results };
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
