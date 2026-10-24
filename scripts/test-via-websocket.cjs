const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

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

function sendCDP(ws, method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = Math.floor(Math.random() * 1000000);
    const handler = (msg) => {
      const res = JSON.parse(msg);
      if (res.id === id) {
        ws.off('message', handler);
        if (res.error) reject(new Error(res.error.message));
        else resolve(res.result);
      }
    };
    ws.on('message', handler);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evalInPage(ws, expression) {
  const res = await sendCDP(ws, 'Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true
  });
  return res.result?.value;
}

function openNewTab(url) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      `http://127.0.0.1:9222/json/new?${encodeURIComponent(url)}`,
      { method: 'PUT' },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve(JSON.parse(data)));
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    req.end();
  });
}

async function run() {
  console.log('=== PURE WEBSOCKET END-TO-END TEST (NO PLAYWRIGHT CDP HIJACKING) ===');
  let targets = await getTargets();
  let extTarget = targets.find(
    (t) => t.type === 'page' && t.url.includes('chrome-extension://pkpgpjlimgpnbggiecpacnmoopnamhhh')
  );
  if (!extTarget) {
    console.log('Opening Batch Studio extension tab...');
    await openNewTab('chrome-extension://pkpgpjlimgpnbggiecpacnmoopnamhhh/index.html');
    await new Promise((r) => setTimeout(r, 1200));
    targets = await getTargets();
    extTarget = targets.find(
      (t) => t.type === 'page' && t.url.includes('chrome-extension://pkpgpjlimgpnbggiecpacnmoopnamhhh')
    );
  }
  const chatTarget = targets.find((t) => t.type === 'page' && t.url.includes('chatgpt.com'));

  if (!extTarget || !chatTarget) {
    throw new Error('Extension or ChatGPT target not found');
  }

  console.log('Connected to Extension Target:', extTarget.title);
  console.log('Connected to ChatGPT Target:', chatTarget.title);

  const extWs = new WebSocket(extTarget.webSocketDebuggerUrl);
  await new Promise((r) => extWs.on('open', r));

  const initialDownloads = new Set(fs.readdirSync('C:/Users/assem/Downloads'));
  const promptText =
    'Generate an image of a majestic glowing cybernetic dragon over a neon cityscape, 8k digital art ' + Date.now();

  console.log('\n[Step 1] Configuring batch in extension UI...');
  await evalInPage(
    extWs,
    `(() => {
      // Switch to Batch Setup
      const buttons = Array.from(document.querySelectorAll('button'));
      const setupBtn = buttons.find(b => b.textContent.includes('Batch Setup'));
      if (setupBtn) setupBtn.click();

      // Clear all
      const clearBtn = buttons.find(b => b.textContent.includes('Clear All'));
      if (clearBtn) clearBtn.click();

      // Select ChatGPT
      const chatBtn = buttons.find(b => b.textContent.includes('ChatGPT') && !b.textContent.includes('Google Flow'));
      if (chatBtn) chatBtn.click();
    })()`
  );

  await new Promise((r) => setTimeout(r, 400));

  await evalInPage(
    extWs,
    `(() => {
      // Open paste prompt textarea if needed
      const textarea = document.querySelector('textarea[data-testid="paste-prompts-textarea"], textarea[placeholder*="Paste one prompt per line"]');
      if (!textarea) {
        const toggleBtn = document.querySelector('[data-testid="paste-prompts-toggle-btn"]');
        if (toggleBtn) toggleBtn.click();
      }
    })()`
  );

  await new Promise((r) => setTimeout(r, 300));

  await evalInPage(
    extWs,
    `(() => {
      const textarea = document.querySelector('textarea[data-testid="paste-prompts-textarea"], textarea[placeholder*="Paste one prompt per line"]');
      if (textarea) {
        const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
        if (nativeSetter) {
          nativeSetter.call(textarea, ${JSON.stringify(promptText)});
        } else {
          textarea.value = ${JSON.stringify(promptText)};
        }
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        textarea.dispatchEvent(new Event('change', { bubbles: true }));
      }
      const addBtn = document.querySelector('[data-testid="add-pasted-prompts-btn"]');
      if (addBtn) addBtn.click();
    })()`
  );

  await new Promise((r) => setTimeout(r, 600));

  console.log('\n[Step 2] Starting Batch Queue...');
  await evalInPage(
    extWs,
    `(() => {
      const startBtn = document.querySelector('[data-testid="start-batch-btn"]');
      if (startBtn) startBtn.click();
    })()`
  );

  console.log('\n[Step 3] Monitoring batch queue execution...');
  const startTime = Date.now();
  let done = false;
  let downloadedFile = null;

  for (let s = 1; s <= 90; s++) {
    await new Promise((r) => setTimeout(r, 1000));
    const status = await evalInPage(
      extWs,
      `(() => {
        const chips = Array.from(document.querySelectorAll('.status-chip, .badge, [class*="status"]')).map(c => c.textContent.trim());
        const friendly = Array.from(document.querySelectorAll('.task-friendly-status, [class*="friendly"]')).map(f => f.textContent.trim());
        const text = document.body.innerText;
        return {
          chips,
          friendly,
          isCompleted: text.includes('Completed') || text.includes('1 / 1') || text.includes('100%') || text.includes('Batch completed')
        };
      })()`
    );

    // Check Downloads directly
    const currentFiles = fs.readdirSync('C:/Users/assem/Downloads');
    for (const f of currentFiles) {
      if (!initialDownloads.has(f) && /\.(png|jpg|jpeg|webp)$/i.test(f)) {
        const stat = fs.statSync(path.join('C:/Users/assem/Downloads', f));
        if (stat.size > 20000) {
          downloadedFile = { name: f, size: stat.size };
        }
      }
    }

    // Also check BatchStudio subfolder
    const subfolder = 'C:/Users/assem/Downloads/BatchStudio';
    if (fs.existsSync(subfolder)) {
      const subFiles = fs.readdirSync(subfolder);
      for (const sf of subFiles) {
        const fullP = path.join(subfolder, sf);
        const stat = fs.statSync(fullP);
        if (stat.mtimeMs >= startTime && stat.size > 20000) {
          downloadedFile = { name: 'BatchStudio/' + sf, size: stat.size };
        }
      }
    }

    if (s % 3 === 0 || status?.isCompleted || downloadedFile) {
      console.log(
        `[+${s}s] Chips: ${JSON.stringify(status?.chips)} | Friendly: ${JSON.stringify(status?.friendly)}${
          downloadedFile ? ` | Downloaded: "${downloadedFile.name}" (${downloadedFile.size} bytes)` : ''
        }`
      );
    }

    if (status?.isCompleted && downloadedFile) {
      console.log(`\n🎉🎉 SUCCESS! Batch completed and image was natively downloaded in ${s}s!`);
      done = true;
      break;
    }
  }

  extWs.close();

  if (!done) {
    throw new Error('Test timed out or download was not verified');
  }
}

run()
  .then(() => {
    console.log('TEST PASSED WITH CODE 0');
    process.exit(0);
  })
  .catch((err) => {
    console.error('TEST FAILED:', err);
    process.exit(1);
  });
