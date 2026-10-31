import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright-core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const distDir = path.resolve(rootDir, 'dist');
const outDir = path.resolve(rootDir, 'screenshots_store');

fs.mkdirSync(outDir, { recursive: true });

const mimeTypes = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.json': 'application/json'
};

function startStaticServer(port = 4567) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let reqPath = req.url.split('?')[0];
      let filePath = path.join(distDir, reqPath === '/' ? 'index.html' : reqPath);
      if (!fs.existsSync(filePath)) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, {
        'Content-Type': mimeTypes[ext] || 'application/octet-stream',
        'Access-Control-Allow-Origin': '*'
      });
      fs.createReadStream(filePath).pipe(res);
    });

    server.listen(port, () => {
      resolve(server);
    });
  });
}

// Generate realistic synthetic artwork for thumbnails using canvas in browser
async function generateSampleArtworkDataUrls(page) {
  return await page.evaluate(() => {
    function createArtwork(type, title, subtitle, colors) {
      const canvas = document.createElement('canvas');
      canvas.width = 720;
      canvas.height = 480;
      const ctx = canvas.getContext('2d');

      // Background gradient
      const grad = ctx.createLinearGradient(0, 0, 720, 480);
      grad.addColorStop(0, colors[0]);
      grad.addColorStop(0.5, colors[1]);
      grad.addColorStop(1, colors[2]);
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, 720, 480);

      // Starfield / particle glow
      for (let i = 0; i < 60; i++) {
        const x = Math.random() * 720;
        const y = Math.random() * 320;
        const r = Math.random() * 2 + 1;
        ctx.fillStyle = `rgba(255, 255, 255, ${Math.random() * 0.7 + 0.3})`;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
      }

      // Skyline or geometric architectural elements
      ctx.fillStyle = 'rgba(10, 12, 22, 0.88)';
      ctx.beginPath();
      ctx.moveTo(0, 480);
      const buildings = [
        [0, 360], [60, 360], [60, 310], [120, 310], [120, 260],
        [170, 260], [170, 340], [240, 340], [240, 220], [300, 220],
        [300, 330], [370, 330], [370, 200], [420, 200], [420, 350],
        [490, 350], [490, 270], [560, 270], [560, 340], [630, 340],
        [630, 290], [720, 290], [720, 480]
      ];
      for (const [bx, by] of buildings) {
        ctx.lineTo(bx, by);
      }
      ctx.closePath();
      ctx.fill();

      // Neon horizon beam
      const beamGrad = ctx.createLinearGradient(0, 340, 720, 340);
      beamGrad.addColorStop(0, 'rgba(236, 72, 153, 0.9)');
      beamGrad.addColorStop(0.5, 'rgba(99, 102, 241, 0.9)');
      beamGrad.addColorStop(1, 'rgba(6, 182, 212, 0.9)');
      ctx.fillStyle = beamGrad;
      ctx.fillRect(0, 335, 720, 5);

      // Water / wet ground reflection
      const reflGrad = ctx.createLinearGradient(0, 340, 0, 480);
      reflGrad.addColorStop(0, 'rgba(99, 102, 241, 0.25)');
      reflGrad.addColorStop(1, 'rgba(13, 16, 23, 0.95)');
      ctx.fillStyle = reflGrad;
      ctx.fillRect(0, 340, 720, 140);

      // Neon reflections
      for (let x = 40; x < 680; x += 45) {
        ctx.fillStyle = x % 90 === 0 ? 'rgba(236, 72, 153, 0.35)' : 'rgba(6, 182, 212, 0.35)';
        ctx.fillRect(x, 345, 18, 90);
      }

      // Title & watermark overlay badge
      ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
      ctx.beginPath();
      ctx.roundRect(24, 24, 260, 58, 8);
      ctx.fill();

      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 15px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
      ctx.fillText(title, 38, 48);

      ctx.fillStyle = 'rgba(255, 255, 255, 0.75)';
      ctx.font = '11px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
      ctx.fillText(subtitle, 38, 67);

      return canvas.toDataURL('image/png');
    }

    return {
      art1: createArtwork('cyberpunk', 'NEON RAIN ALLEY', 'AI Batch Studio #001 · ChatGPT', ['#0f172a', '#312e81', '#4c1d95']),
      art2: createArtwork('highway', 'HOVER HIGHWAY TWILIGHT', 'AI Batch Studio #002 · ChatGPT', ['#1e1b4b', '#1e3a8a', '#064e3b']),
      art3: createArtwork('cyborg', 'CYBORG TEA CEREMONY', 'AI Batch Studio #003 · ChatGPT', ['#3b0764', '#701a75', '#831843']),
      refCharacter: createArtwork('ref1', 'STYLE REFERENCE', 'Cyberpunk Neon Palette', ['#18181b', '#27272a', '#3f3f46']),
      refStyle: createArtwork('ref2', 'CHARACTER REFERENCE', 'Hero Detective Model', ['#09090b', '#1c1917', '#292524'])
    };
  });
}

async function seedDatabase(page, artworks) {
  await page.evaluate(async (arts) => {
    const DB_NAME = 'BatchStudioDB';
    const DB_VERSION = 1;

    // Helper to open DB
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const d = e.target.result;
        if (!d.objectStoreNames.contains('batches')) {
          d.createObjectStore('batches', { keyPath: 'id' }).createIndex('by_updatedAt', 'updatedAt');
        }
        if (!d.objectStoreNames.contains('tasks')) {
          d.createObjectStore('tasks', { keyPath: 'id' }).createIndex('by_batchId', 'batchId');
        }
        if (!d.objectStoreNames.contains('outputs')) {
          const out = d.createObjectStore('outputs', { keyPath: 'id' });
          out.createIndex('by_taskId', 'taskId');
          out.createIndex('by_batchId', 'batchId');
          out.createIndex('by_downloadId', 'downloadId');
        }
        if (!d.objectStoreNames.contains('references')) {
          d.createObjectStore('references', { keyPath: 'id' });
        }
        if (!d.objectStoreNames.contains('referenceBlobs')) {
          d.createObjectStore('referenceBlobs', { keyPath: 'storageKey' });
        }
        if (!d.objectStoreNames.contains('logs')) {
          d.createObjectStore('logs', { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });

    const now = Date.now();
    const batchId = 'batch_showcase_1';

    const batch = {
      id: batchId,
      name: 'Cyberpunk Metropolis Odyssey',
      platform: 'chatgpt',
      taskType: 'image',
      status: 'running',
      globalPrefix: 'Cinematic 8k resolution, octane render, dramatic neon rim lighting, award-winning concept art.',
      prefixEnabled: true,
      prefixSeparator: '\n\n',
      referenceIds: ['ref_1', 'ref_2'],
      taskIds: ['task_1', 'task_2', 'task_3', 'task_4', 'task_5', 'task_6', 'task_7', 'task_8'],
      defaultGenerationSettings: {
        aspectRatio: '16:9',
        outputCount: 1
      },
      downloadSettings: {
        saveMode: 'downloads_subfolder',
        subfolder: 'BatchStudio/Cyberpunk/{date}',
        filenameTemplate: '{number}_{project}_{prompt}',
        autoNumbering: {
          enabled: true,
          startNumber: 1,
          paddingDigits: 3,
          separator: '_'
        },
        conflictAction: 'uniquify'
      },
      timeoutSettings: {
        initialObservationMinSec: 10,
        initialObservationMaxSec: 15,
        maxImageTimeoutSec: 180,
        maxVideoTimeoutSec: 420,
        pollIntervalSec: 3,
        timeoutPolicy: 'keep_waiting',
        maxAutoRetries: 2
      },
      activeTaskId: 'task_4',
      circuitBreakerLimit: 3,
      consecutiveFailureCount: 0,
      maxConcurrency: 1,
      nextOutputSequenceNumber: 4,
      createdAt: now - 180000,
      updatedAt: now
    };

    const tasks = [
      {
        id: 'task_1',
        batchId,
        sequenceNumber: 1,
        name: 'Neon Rain Alley',
        originalPrompt: 'Cyberpunk detective in a holographic trench coat standing in a rain-slicked alleyway reflecting vibrant neon signs',
        finalPromptSnapshot: 'Cinematic 8k resolution, octane render, dramatic neon rim lighting, award-winning concept art.\n\nCyberpunk detective in a holographic trench coat standing in a rain-slicked alleyway reflecting vibrant neon signs',
        platform: 'chatgpt',
        taskType: 'image',
        status: 'completed',
        friendlyStatus: 'Completed.',
        referenceIds: ['ref_1'],
        generationSettings: { aspectRatio: '16:9' },
        createdAt: now - 180000,
        updatedAt: now - 152000,
        submittedAt: now - 180000,
        completedAt: now - 152000, // 28s duration
        retryCount: 0,
        outputIds: ['out_1']
      },
      {
        id: 'task_2',
        batchId,
        sequenceNumber: 2,
        name: 'Floating Skyscape Highway',
        originalPrompt: 'Futuristic magnetic levitation hover vehicles cruising through towering crystal glass skyscrapers at sunset',
        finalPromptSnapshot: 'Cinematic 8k resolution, octane render, dramatic neon rim lighting, award-winning concept art.\n\nFuturistic magnetic levitation hover vehicles cruising through towering crystal glass skyscrapers at sunset',
        platform: 'chatgpt',
        taskType: 'image',
        status: 'completed',
        friendlyStatus: 'Completed.',
        referenceIds: ['ref_2'],
        generationSettings: { aspectRatio: '16:9' },
        createdAt: now - 150000,
        updatedAt: now - 119000,
        submittedAt: now - 150000,
        completedAt: now - 119000, // 31s duration
        retryCount: 0,
        outputIds: ['out_2']
      },
      {
        id: 'task_3',
        batchId,
        sequenceNumber: 3,
        name: 'Cyborg Geisha Tea Ceremony',
        originalPrompt: 'Close-up portrait of an elegant cyborg with porcelain skin and delicate golden fiber-optic circuits, traditional tea ceremony',
        finalPromptSnapshot: 'Cinematic 8k resolution, octane render, dramatic neon rim lighting, award-winning concept art.\n\nClose-up portrait of an elegant cyborg with porcelain skin and delicate golden fiber-optic circuits, traditional tea ceremony',
        platform: 'chatgpt',
        taskType: 'image',
        status: 'completed',
        friendlyStatus: 'Completed.',
        referenceIds: ['ref_1', 'ref_2'],
        generationSettings: { aspectRatio: '16:9' },
        createdAt: now - 118000,
        updatedAt: now - 92000,
        submittedAt: now - 118000,
        completedAt: now - 92000, // 26s duration
        retryCount: 0,
        outputIds: ['out_3']
      },
      {
        id: 'task_4',
        batchId,
        sequenceNumber: 4,
        name: 'Underground Hacker Lair',
        originalPrompt: 'Sprawling underground hacker lair filled with modular CRT monitors, glowing server racks, and holographic terminal interfaces',
        finalPromptSnapshot: 'Cinematic 8k resolution, octane render, dramatic neon rim lighting, award-winning concept art.\n\nSprawling underground hacker lair filled with modular CRT monitors, glowing server racks, and holographic terminal interfaces',
        platform: 'chatgpt',
        taskType: 'image',
        status: 'generating',
        friendlyStatus: 'Waiting for generation (14s elapsed).',
        referenceIds: [],
        generationSettings: { aspectRatio: '16:9' },
        createdAt: now - 90000,
        updatedAt: now,
        submittedAt: now - 14000,
        retryCount: 0,
        outputIds: []
      },
      {
        id: 'task_5',
        batchId,
        sequenceNumber: 5,
        name: 'Orbital Elevator Base',
        originalPrompt: 'Massive space elevator base station towering into the twilight atmosphere, searchlights piercing swirling clouds',
        finalPromptSnapshot: 'Cinematic 8k resolution, octane render, dramatic neon rim lighting, award-winning concept art.\n\nMassive space elevator base station towering into the twilight atmosphere, searchlights piercing swirling clouds',
        platform: 'chatgpt',
        taskType: 'image',
        status: 'pending',
        friendlyStatus: 'Ready to start.',
        referenceIds: [],
        generationSettings: { aspectRatio: '16:9' },
        createdAt: now - 80000,
        updatedAt: now - 80000,
        retryCount: 0,
        outputIds: []
      },
      {
        id: 'task_6',
        batchId,
        sequenceNumber: 6,
        name: 'Cybernetically Enhanced Panther',
        originalPrompt: 'Sleek mechanical black panther with glowing cyan LED eyes prowling rooftop gardens overlooking a dense cyber city',
        finalPromptSnapshot: 'Cinematic 8k resolution, octane render, dramatic neon rim lighting, award-winning concept art.\n\nSleek mechanical black panther with glowing cyan LED eyes prowling rooftop gardens overlooking a dense cyber city',
        platform: 'chatgpt',
        taskType: 'image',
        status: 'pending',
        friendlyStatus: 'Ready to start.',
        referenceIds: [],
        generationSettings: { aspectRatio: '16:9' },
        createdAt: now - 70000,
        updatedAt: now - 70000,
        retryCount: 0,
        outputIds: []
      }
    ];

    const outputs = [
      {
        id: 'out_1',
        batchId,
        taskId: 'task_1',
        platform: 'chatgpt',
        type: 'image',
        index: 0,
        assignedSequenceNumber: 1,
        originalPrompt: tasks[0].originalPrompt,
        finalSubmittedPrompt: tasks[0].finalPromptSnapshot,
        generationStatus: 'completed',
        status: 'completed',
        filename: '001_Cyberpunk_Neon_Rain_Alley.png',
        sourceUrl: arts.art1,
        previewUrl: arts.art1,
        retryCount: 0,
        createdAt: now - 180000,
        completedAt: now - 152000
      },
      {
        id: 'out_2',
        batchId,
        taskId: 'task_2',
        platform: 'chatgpt',
        type: 'image',
        index: 0,
        assignedSequenceNumber: 2,
        originalPrompt: tasks[1].originalPrompt,
        finalSubmittedPrompt: tasks[1].finalPromptSnapshot,
        generationStatus: 'completed',
        status: 'completed',
        filename: '002_Cyberpunk_Hover_Vehicles.png',
        sourceUrl: arts.art2,
        previewUrl: arts.art2,
        retryCount: 0,
        createdAt: now - 150000,
        completedAt: now - 119000
      },
      {
        id: 'out_3',
        batchId,
        taskId: 'task_3',
        platform: 'chatgpt',
        type: 'image',
        index: 0,
        assignedSequenceNumber: 3,
        originalPrompt: tasks[2].originalPrompt,
        finalSubmittedPrompt: tasks[2].finalPromptSnapshot,
        generationStatus: 'completed',
        status: 'completed',
        filename: '003_Cyberpunk_Cyborg_Geisha.png',
        sourceUrl: arts.art3,
        previewUrl: arts.art3,
        retryCount: 0,
        createdAt: now - 118000,
        completedAt: now - 92000
      }
    ];

    const references = [
      {
        id: 'ref_1',
        name: 'neon_noir_palette.png',
        type: 'art_style',
        mimeType: 'image/png',
        size: 42000,
        storageKey: 'key_ref_1',
        thumbnailDataUrl: arts.refStyle,
        createdAt: now - 200000
      },
      {
        id: 'ref_2',
        name: 'detective_character.png',
        type: 'character',
        mimeType: 'image/png',
        size: 58000,
        storageKey: 'key_ref_2',
        thumbnailDataUrl: arts.refCharacter,
        createdAt: now - 200000
      }
    ];

    // Put into IndexedDB
    const tx = db.transaction(['batches', 'tasks', 'outputs', 'references'], 'readwrite');
    tx.objectStore('batches').put(batch);
    for (const t of tasks) tx.objectStore('tasks').put(t);
    for (const o of outputs) tx.objectStore('outputs').put(o);
    for (const r of references) tx.objectStore('references').put(r);

    await new Promise((res, rej) => {
      tx.oncomplete = res;
      tx.onerror = rej;
    });

    // Set Chrome storage mock keys
    localStorage.setItem('batch_studio_active_batch_id_v1', JSON.stringify(batchId));
    localStorage.setItem('batch_studio_preferences_v1', JSON.stringify({
      defaultPlatform: 'chatgpt',
      defaultTaskType: 'image',
      sharedPrefix: batch.globalPrefix,
      prefixEnabled: true,
      prefixSeparator: '\n\n',
      downloadPreferences: batch.downloadSettings,
      timeoutSettings: batch.timeoutSettings,
      defaultGenerationSettings: batch.defaultGenerationSettings,
      theme: 'dark',
      notificationsEnabled: true,
      soundEnabled: true,
      circuitBreakerLimit: 3,
      maxConcurrency: 1,
      globalOutputCounter: 4
    }));
  }, artworks);
}

// Generates branded, high-impact presentation cards (1280x800) for Chrome Web Store
async function renderShowcaseCard(browser, options) {
  const {
    title,
    badge,
    description,
    appScreenshotBuffer,
    outputPath,
    accentColor = '#6366f1'
  } = options;

  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
          width: 1280px;
          height: 800px;
          overflow: hidden;
          background: radial-gradient(circle at 50% 0%, #1e1b4b 0%, #0d1017 65%, #07090e 100%);
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Inter, sans-serif;
          color: #ffffff;
          position: relative;
          display: flex;
          flex-direction: column;
          align-items: center;
        }

        /* Subtle ambient glow */
        .ambient-glow {
          position: absolute;
          top: -120px;
          left: 50%;
          transform: translateX(-50%);
          width: 800px;
          height: 400px;
          background: radial-gradient(circle, ${accentColor}44 0%, transparent 70%);
          filter: blur(80px);
          pointer-events: none;
        }

        .header {
          margin-top: 36px;
          text-align: center;
          z-index: 10;
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 8px;
        }

        .badge {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          padding: 4px 12px;
          border-radius: 999px;
          background: ${accentColor}26;
          border: 1px solid ${accentColor}66;
          color: #e0e7ff;
          font-size: 11.5px;
          font-weight: 700;
          letter-spacing: 0.08em;
          text-transform: uppercase;
        }

        .title {
          font-size: 32px;
          font-weight: 800;
          letter-spacing: -0.02em;
          background: linear-gradient(180deg, #ffffff 30%, #cbd5e1 100%);
          -webkit-background-clip: text;
          -webkit-text-fill-color: transparent;
          line-height: 1.2;
        }

        .subtitle {
          font-size: 14.5px;
          color: #94a3b8;
          max-width: 780px;
          line-height: 1.4;
        }

        /* Device mockup window */
        .window-frame {
          position: absolute;
          bottom: -40px;
          width: 960px;
          height: 590px;
          background: #151923;
          border-radius: 12px 12px 0 0;
          border: 1px solid rgba(255, 255, 255, 0.12);
          border-bottom: none;
          box-shadow: 0 24px 64px rgba(0, 0, 0, 0.65), 0 0 0 1px rgba(255, 255, 255, 0.05);
          display: flex;
          flex-direction: column;
          overflow: hidden;
          z-index: 5;
        }

        .window-bar {
          height: 34px;
          background: #11141d;
          border-bottom: 1px solid rgba(255, 255, 255, 0.08);
          display: flex;
          align-items: center;
          padding: 0 14px;
          gap: 8px;
        }

        .dots {
          display: flex;
          gap: 6px;
        }

        .dot {
          width: 10px;
          height: 10px;
          border-radius: 50%;
        }
        .dot-red { background: #ef4444; }
        .dot-yellow { background: #f59e0b; }
        .dot-green { background: #10b981; }

        .address-bar {
          flex: 1;
          height: 22px;
          background: #1c2230;
          border-radius: 5px;
          margin: 0 16px;
          display: flex;
          align-items: center;
          padding: 0 10px;
          font-size: 11px;
          color: #64748b;
          font-family: monospace;
        }

        .window-body {
          flex: 1;
          background: #0d1017;
          overflow: hidden;
          position: relative;
        }

        .window-body img {
          width: 100%;
          height: auto;
          display: block;
        }
      </style>
    </head>
    <body>
      <div class="ambient-glow"></div>
      <div class="header">
        <div class="badge">${badge}</div>
        <h1 class="title">${title}</h1>
        <p class="subtitle">${description}</p>
      </div>
      <div class="window-frame">
        <div class="window-bar">
          <div class="dots">
            <div class="dot dot-red"></div>
            <div class="dot dot-yellow"></div>
            <div class="dot dot-green"></div>
          </div>
          <div class="address-bar">chrome-extension://ai-batch-studio/index.html</div>
        </div>
        <div class="window-body">
          <img src="data:image/png;base64,${appScreenshotBuffer.toString('base64')}" />
        </div>
      </div>
    </body>
    </html>
  `;

  await page.setContent(html);
  await page.waitForTimeout(300);
  await page.screenshot({ path: outputPath });
  await page.close();
}

async function run() {
  console.log('Starting static server on port 4567...');
  const server = await startStaticServer(4567);

  console.log('Launching Chrome browser with Playwright...');
  const browser = await chromium.launch({ channel: 'chrome', headless: true });

  const page = await browser.newPage({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1
  });

  // Inject Chrome Extension API polyfills into renderer context
  await page.addInitScript(() => {
    window.chrome = window.chrome || {};
    window.chrome.storage = {
      local: {
        get: (keys) => {
          const out = {};
          if (typeof keys === 'string') {
            const val = localStorage.getItem(keys);
            if (val !== null) {
              try { out[keys] = JSON.parse(val); } catch (e) { out[keys] = val; }
            }
            return Promise.resolve(out);
          }
          if (Array.isArray(keys)) {
            for (const k of keys) {
              const val = localStorage.getItem(k);
              if (val !== null) {
                try { out[k] = JSON.parse(val); } catch (e) { out[k] = val; }
              }
            }
            return Promise.resolve(out);
          }
          for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            const val = localStorage.getItem(k);
            try { out[k] = JSON.parse(val); } catch (e) { out[k] = val; }
          }
          return Promise.resolve(out);
        },
        set: (items) => {
          for (const [k, v] of Object.entries(items)) {
            localStorage.setItem(k, JSON.stringify(v));
          }
          return Promise.resolve();
        },
        remove: (keys) => {
          const arr = Array.isArray(keys) ? keys : [keys];
          for (const k of arr) localStorage.removeItem(k);
          return Promise.resolve();
        }
      }
    };
    window.chrome.runtime = window.chrome.runtime || {
      getURL: (p) => p,
      sendMessage: () => Promise.resolve({ success: true }),
      onMessage: {
        addListener: () => {},
        removeListener: () => {}
      }
    };
  });

  // Navigate to local extension app
  await page.goto('http://localhost:4567');
  await page.waitForTimeout(500);

  // Generate synthetic artworks and seed IndexedDB
  console.log('Seeding IndexedDB with demo batch and outputs...');
  const artworks = await generateSampleArtworkDataUrls(page);
  await seedDatabase(page, artworks);

  // Reload page to reflect seeded active batch
  await page.reload();
  await page.waitForTimeout(1000);

  // ==========================================
  // SCREENSHOT 1: Live Queue Monitor View
  // ==========================================
  console.log('Generating Screenshot 1: Queue Monitor...');
  // Ensure Queue tab is active
  const queueTabBtn = await page.$('[data-testid="nav-tab-queue"]');
  if (queueTabBtn) await queueTabBtn.click();
  await page.waitForTimeout(500);

  const queueBuf = await page.screenshot({ path: path.join(outDir, '1_queue_monitor.png') });

  // ==========================================
  // SCREENSHOT 2: Lightbox Modal Overlay
  // ==========================================
  console.log('Generating Screenshot 2: Lightbox Gallery Modal...');
  const firstThumb = await page.$('[data-testid="output-thumb-0"]');
  if (firstThumb) {
    await firstThumb.click();
    await page.waitForTimeout(400);
  }
  const lightboxBuf = await page.screenshot({ path: path.join(outDir, '2_lightbox_gallery.png') });

  // Close lightbox modal
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  // ==========================================
  // SCREENSHOT 3: Batch Setup & Matrix Prompts
  // ==========================================
  console.log('Generating Screenshot 3: Batch Setup & Matrix Expansion...');
  const studioTabBtn = await page.$('[data-testid="nav-tab-studio"]');
  if (studioTabBtn) await studioTabBtn.click();
  await page.waitForTimeout(400);

  // Open Paste Prompts panel if collapsed
  let pasteArea = await page.$('[data-testid="paste-prompts-textarea"]');
  if (!pasteArea) {
    const toggleBtn = await page.$('[data-testid="paste-prompts-toggle-btn"]');
    if (toggleBtn) {
      await toggleBtn.click();
      await page.waitForTimeout(300);
      pasteArea = await page.$('[data-testid="paste-prompts-textarea"]');
    }
  }

  // Enter matrix prompt with permutation brackets
  if (pasteArea) {
    await pasteArea.fill('A {golden hour, neon twilight} cinematic portrait of a {cyberpunk detective, rogue pilot} in Tokyo');
    await page.waitForTimeout(400);
  }
  const matrixBuf = await page.screenshot({ path: path.join(outDir, '3_batch_setup_matrix.png') });

  // Expand variations into individual prompts
  const expandBtn = await page.$('[data-testid="expand-variations-btn"]');
  if (expandBtn) {
    await expandBtn.click();
    await page.waitForTimeout(300);
  }
  const addBtn = await page.$('[data-testid="add-pasted-prompts-btn"]');
  if (addBtn) {
    await addBtn.click();
    await page.waitForTimeout(400);
  }

  // ==========================================
  // SCREENSHOT 4: Advanced Timing & Circuit Breaker
  // ==========================================
  console.log('Generating Screenshot 4: Advanced Timing & Safety Controls...');
  const advToggle = await page.$('[data-testid="toggle-advanced-settings"]');
  if (advToggle) {
    await advToggle.click();
    await page.waitForTimeout(400);
  }
  // Scroll slightly down to showcase circuit breaker and template tokens
  await page.evaluate(() => window.scrollBy(0, 360));
  await page.waitForTimeout(300);

  const advBuf = await page.screenshot({ path: path.join(outDir, '4_advanced_safety_settings.png') });

  // ==========================================
  // SCREENSHOT 5: Google Flow Video & Reference Workflows
  // ==========================================
  console.log('Generating Screenshot 5: Google Flow Video & Reference Workflows...');
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);

  // Select Google Flow platform
  const flowPlatformBtn = await page.$('[data-testid="select-platform-google-flow"]');
  if (flowPlatformBtn) {
    await flowPlatformBtn.click();
    await page.waitForTimeout(300);
  }

  // Select Video mode
  const videoModeBtn = await page.$('[data-testid="select-mode-video"]');
  if (videoModeBtn) {
    await videoModeBtn.click();
    await page.waitForTimeout(300);
  }

  const flowBuf = await page.screenshot({ path: path.join(outDir, '5_google_flow_video_workflow.png') });

  // ==========================================
  // NOW GENERATE HIGH-CONVERTING STORE SHOWCASE CARDS (1280x800)
  // ==========================================
  console.log('Generating Chrome Web Store Presentation Slides (1280x800)...');

  await renderShowcaseCard(browser, {
    badge: 'Sequential Batch Engine',
    title: 'Automate Prompts on ChatGPT & Google Flow',
    description: 'Queue dozens of image and video generations with multi-model support, reference image injection, and zero duplicate submissions.',
    appScreenshotBuffer: queueBuf,
    outputPath: path.join(outDir, 'store_slide_1_batch_automation.png'),
    accentColor: '#6366f1'
  });

  await renderShowcaseCard(browser, {
    badge: 'Queue Intelligence & Safety',
    title: 'Live Rolling ETA & Credit Circuit Breaker',
    description: 'Track real-time generation countdowns, rolling averages, and prevent credit waste with automatic pause on repeated failures.',
    appScreenshotBuffer: queueBuf,
    outputPath: path.join(outDir, 'store_slide_2_queue_monitor.png'),
    accentColor: '#10b981'
  });

  await renderShowcaseCard(browser, {
    badge: 'Lossless Auto-Downloader',
    title: 'Instant Verified Downloads & Lightbox Gallery',
    description: 'Automatic Base64 blob-to-disk downloads organized into dynamic {project}/{date} subfolders with full-screen lightbox inspection.',
    appScreenshotBuffer: lightboxBuf,
    outputPath: path.join(outDir, 'store_slide_3_lightbox_downloads.png'),
    accentColor: '#ec4899'
  });

  await renderShowcaseCard(browser, {
    badge: 'Prompt Matrix Engineering',
    title: 'Multiply Variations with Permutation Syntax',
    description: 'Easily expand combinatorial variations with brackets like {red, blue} sports car on {beach, city street} into individual queued tasks.',
    appScreenshotBuffer: matrixBuf,
    outputPath: path.join(outDir, 'store_slide_4_matrix_variations.png'),
    accentColor: '#8b5cf6'
  });

  await renderShowcaseCard(browser, {
    badge: 'Google Flow Video & References',
    title: 'Reference Asset Management & Video Workflows',
    description: 'Seamless integration with Google Flow Veo 2, Veo 3, start-and-end frames, and multi-asset character/style reference banks.',
    appScreenshotBuffer: flowBuf,
    outputPath: path.join(outDir, 'store_slide_5_google_flow.png'),
    accentColor: '#06b6d4'
  });

  // ==========================================
  // SMALL PROMOTIONAL TILE (440x280)
  // ==========================================
  console.log('Generating Small Promo Tile (440x280)...');
  const promoPage = await browser.newPage({ viewport: { width: 440, height: 280 } });
  await promoPage.setContent(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
          width: 440px;
          height: 280px;
          overflow: hidden;
          background: radial-gradient(circle at 50% 30%, #312e81 0%, #0d1017 90%);
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
          color: #ffffff;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          text-align: center;
          padding: 24px;
          position: relative;
        }
        .glow {
          position: absolute;
          width: 240px;
          height: 140px;
          background: #6366f1;
          filter: blur(60px);
          opacity: 0.35;
        }
        .icon-box {
          width: 64px;
          height: 64px;
          border-radius: 16px;
          background: linear-gradient(135deg, #4f46e5, #9333ea);
          display: flex;
          align-items: center;
          justify-content: center;
          box-shadow: 0 8px 24px rgba(79, 70, 229, 0.45);
          margin-bottom: 14px;
          z-index: 2;
        }
        .icon-box img {
          width: 44px;
          height: 44px;
        }
        h1 {
          font-size: 22px;
          font-weight: 800;
          letter-spacing: -0.02em;
          margin-bottom: 6px;
          z-index: 2;
        }
        p {
          font-size: 12px;
          color: #94a3b8;
          max-width: 320px;
          line-height: 1.4;
          z-index: 2;
        }
        .pill {
          margin-top: 10px;
          font-size: 10px;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0.08em;
          padding: 3px 10px;
          border-radius: 999px;
          background: rgba(99, 102, 241, 0.2);
          border: 1px solid rgba(99, 102, 241, 0.5);
          color: #c7d2fe;
          z-index: 2;
        }
      </style>
    </head>
    <body>
      <div class="glow"></div>
      <div class="icon-box">
        <img src="http://localhost:4567/icons/icon-48.png" />
      </div>
      <h1>AI Batch Studio</h1>
      <p>Batch AI Image & Video Queue for ChatGPT & Google Flow</p>
      <div class="pill">Sequential Queue · Auto Download</div>
    </body>
    </html>
  `);
  await promoPage.waitForTimeout(300);
  await promoPage.screenshot({ path: path.join(outDir, 'promo_small_440x280.png') });
  await promoPage.close();

  // ==========================================
  // MARQUEE PROMOTIONAL TILE (1400x560)
  // ==========================================
  console.log('Generating Marquee Promo Tile (1400x560)...');
  const marqueePage = await browser.newPage({ viewport: { width: 1400, height: 560 } });
  await marqueePage.setContent(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
          width: 1400px;
          height: 560px;
          overflow: hidden;
          background: radial-gradient(circle at 65% 50%, #1e1b4b 0%, #0d1017 75%, #05070a 100%);
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
          color: #ffffff;
          display: flex;
          align-items: center;
          padding: 0 80px;
          position: relative;
        }
        .glow {
          position: absolute;
          right: 200px;
          width: 500px;
          height: 400px;
          background: #6366f1;
          filter: blur(120px);
          opacity: 0.3;
        }
        .content {
          max-width: 620px;
          z-index: 2;
        }
        .pill {
          display: inline-block;
          font-size: 12px;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0.08em;
          padding: 4px 12px;
          border-radius: 999px;
          background: rgba(99, 102, 241, 0.2);
          border: 1px solid rgba(99, 102, 241, 0.5);
          color: #c7d2fe;
          margin-bottom: 16px;
        }
        h1 {
          font-size: 46px;
          font-weight: 800;
          letter-spacing: -0.02em;
          line-height: 1.15;
          margin-bottom: 14px;
        }
        p {
          font-size: 18px;
          color: #94a3b8;
          line-height: 1.5;
          margin-bottom: 24px;
        }
        .tags {
          display: flex;
          gap: 12px;
        }
        .tag {
          font-size: 13px;
          background: #1c2230;
          border: 1px solid #2e384d;
          padding: 6px 14px;
          border-radius: 6px;
          color: #e2e8f0;
        }
        .mockup-preview {
          position: absolute;
          right: 60px;
          width: 600px;
          height: 440px;
          border-radius: 12px;
          overflow: hidden;
          box-shadow: 0 24px 64px rgba(0,0,0,0.7), 0 0 0 1px rgba(255,255,255,0.1);
          z-index: 2;
        }
        .mockup-preview img {
          width: 100%;
          height: auto;
          display: block;
        }
      </style>
    </head>
    <body>
      <div class="glow"></div>
      <div class="content">
        <div class="pill">Chrome Extension Manifest V3</div>
        <h1>AI Batch Studio</h1>
        <p>Sequential batch prompt execution, matrix permutations, and automatic downloads for ChatGPT & Google Flow.</p>
        <div class="tags">
          <div class="tag">✓ ChatGPT & Google Flow</div>
          <div class="tag">✓ Image & Video Batches</div>
          <div class="tag">✓ Credit Circuit Breaker</div>
        </div>
      </div>
      <div class="mockup-preview">
        <img src="data:image/png;base64,${queueBuf.toString('base64')}" />
      </div>
    </body>
    </html>
  `);
  await marqueePage.waitForTimeout(300);
  await marqueePage.screenshot({ path: path.join(outDir, 'promo_marquee_1400x560.png') });
  await marqueePage.close();

  await browser.close();
  server.close();
  console.log('Finished generating all Chrome Web Store screenshots & promo tiles in ./screenshots_store!');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
