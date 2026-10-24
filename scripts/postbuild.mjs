import { build } from 'vite';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import zlib from 'zlib';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');
const distDir = resolve(rootDir, 'dist');

function createPngBuffer(size) {
  // Creates a valid RGBA PNG icon with a modern indigo-violet rounded square and white play/layers motif
  const width = size;
  const height = size;
  const rawData = Buffer.alloc(height * (1 + width * 4));

  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + width * 4);
    rawData[rowStart] = 0; // No filter
    for (let x = 0; x < width; x++) {
      const px = rowStart + 1 + x * 4;
      const nx = x / (width - 1);
      const ny = y / (height - 1);

      // Rounded rect mask
      const margin = 0.06;
      const radius = 0.22;
      let inside = true;
      if (nx < margin || nx > 1 - margin || ny < margin || ny > 1 - margin) {
        inside = false;
      } else {
        const cx = nx < margin + radius ? margin + radius : nx > 1 - margin - radius ? 1 - margin - radius : nx;
        const cy = ny < margin + radius ? margin + radius : ny > 1 - margin - radius ? 1 - margin - radius : ny;
        const dist = Math.hypot(nx - cx, ny - cy);
        if (dist > radius) inside = false;
      }

      if (!inside) {
        rawData[px] = 0;
        rawData[px + 1] = 0;
        rawData[px + 2] = 0;
        rawData[px + 3] = 0;
        continue;
      }

      // Indigo-to-violet gradient background
      let r = Math.round(79 + (124 - 79) * nx);
      let g = Math.round(70 + (58 - 70) * ny);
      let b = Math.round(229 + (237 - 229) * nx);

      // Draw stacked cards + play symbol in white
      const inTopBar = nx >= 0.26 && nx <= 0.74 && ny >= 0.25 && ny <= 0.35;
      const inMidBar = nx >= 0.26 && nx <= 0.74 && ny >= 0.45 && ny <= 0.55;
      const inBotBar = nx >= 0.26 && nx <= 0.56 && ny >= 0.65 && ny <= 0.75;
      const inAccentDot = Math.hypot(nx - 0.68, ny - 0.70) <= 0.07;

      if (inTopBar || inMidBar || inBotBar) {
        r = 255;
        g = 255;
        b = 255;
      } else if (inAccentDot) {
        r = 52;
        g = 211;
        b = 153;
      }

      rawData[px] = r;
      rawData[px + 1] = g;
      rawData[px + 2] = b;
      rawData[px + 3] = 255;
    }
  }

  const compressed = zlib.deflateSync(rawData);

  function crc32(buf) {
    let crc = 0xffffffff;
    for (let i = 0; i < buf.length; i++) {
      crc ^= buf[i];
      for (let j = 0; j < 8; j++) {
        crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
      }
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  function makeChunk(type, data) {
    const typeBuf = Buffer.from(type, 'ascii');
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32BE(data.length, 0);
    const crcInput = Buffer.concat([typeBuf, data]);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(crcInput), 0);
    return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
  }

  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    signature,
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', compressed),
    makeChunk('IEND', Buffer.alloc(0))
  ]);
}

async function runPostBuild() {
  console.log('Building background service worker...');
  await build({
    configFile: false,
    build: {
      outDir: resolve(distDir, 'background'),
      emptyOutDir: false,
      lib: {
        entry: resolve(rootDir, 'src/background/serviceWorker.ts'),
        name: 'BatchStudioServiceWorker',
        formats: ['es'],
        fileName: () => 'serviceWorker.js'
      },
      rollupOptions: {
        output: {
          inlineDynamicImports: true
        }
      }
    }
  });

  console.log('Building content script...');
  await build({
    configFile: false,
    build: {
      outDir: resolve(distDir, 'content'),
      emptyOutDir: false,
      lib: {
        entry: resolve(rootDir, 'src/content/index.ts'),
        name: 'BatchStudioContentScript',
        formats: ['iife'],
        fileName: () => 'index.js'
      },
      rollupOptions: {
        output: {
          inlineDynamicImports: true
        }
      }
    }
  });

  // Ensure icons exist in public/icons and dist/icons
  const iconSizes = [16, 32, 48, 128];
  const publicIconsDir = resolve(rootDir, 'public/icons');
  const distIconsDir = resolve(distDir, 'icons');
  fs.mkdirSync(publicIconsDir, { recursive: true });
  fs.mkdirSync(distIconsDir, { recursive: true });

  for (const size of iconSizes) {
    const png = createPngBuffer(size);
    fs.writeFileSync(resolve(publicIconsDir, `icon-${size}.png`), png);
    fs.writeFileSync(resolve(distIconsDir, `icon-${size}.png`), png);
  }

  // Copy manifest.json to dist/manifest.json
  const manifestSrc = resolve(rootDir, 'public/manifest.json');
  const manifestDest = resolve(distDir, 'manifest.json');
  fs.copyFileSync(manifestSrc, manifestDest);

  // Verify all files referenced in manifest.json exist in dist/
  const manifest = JSON.parse(fs.readFileSync(manifestDest, 'utf-8'));
  const requiredPaths = [
    manifest.action?.default_popup,
    manifest.background?.service_worker,
    ...(manifest.content_scripts?.flatMap((cs) => cs.js) || []),
    ...Object.values(manifest.icons || {})
  ].filter(Boolean);

  for (const relPath of requiredPaths) {
    const absPath = resolve(distDir, relPath);
    if (!fs.existsSync(absPath)) {
      throw new Error(`Build verification failed: missing required manifest asset "${relPath}" at ${absPath}`);
    }
  }

  console.log('Postbuild completed and verified successfully:', requiredPaths);
}

runPostBuild().catch((err) => {
  console.error(err);
  process.exit(1);
});
