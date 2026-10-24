const { chromium } = require('playwright-core');

async function testAdapterStatus() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const context = browser.contexts()[0];
  const flowPage = context.pages().find((p) => p.url().includes('flow.google.com/project'));

  const status = await flowPage.evaluate(async () => {
    // Check what elements are found by findOutputElements
    const taskType = 'image';
    const excludedContainerSelector =
      '.boqOnegoogleliteOgbOneGoogleBar, #gb, mat-sidenav, nav, header, aside, [role="navigation"], [role="menu"], [data-testid*="composer"], footer, .composer';

    const workspaceImages = Array.from(
      document.querySelectorAll(
        'img[src*="flow-content.google"], img[src*="googleusercontent"], img[src*="ggpht"], img[src^="blob:"], img[src^="data:image/"], aisandbox-root img[src], main img[src]'
      )
    ).filter((img) => {
      if (img.closest(excludedContainerSelector)) return false;
      const src = (img.currentSrc || img.src || img.getAttribute('src') || '').toLowerCase();
      if (!src || src.includes('/ogw/') || /(?:googleusercontent\.com|ggpht\.com)\/(?:a|a-)\b/i.test(src) || /=s(16|20|24|32|40|48|64|83|96)\b/.test(src)) return false;
      return true;
    });

    const baselineAttr = document.body.getAttribute('data-batch-studio-baseline-outputs');
    const rawUrlsAttr = document.body.getAttribute('data-batch-studio-baseline-urls');
    let baselineUrls = null;
    if (rawUrlsAttr) {
      try { baselineUrls = new Set(JSON.parse(rawUrlsAttr)); } catch {}
    }

    return {
      workspaceImagesCount: workspaceImages.length,
      workspaceImages: workspaceImages.map(img => ({
        src: img.src.slice(0, 80),
        offsetWidth: img.offsetWidth,
        offsetHeight: img.offsetHeight,
        complete: img.complete,
        naturalWidth: img.naturalWidth
      })),
      baselineAttr,
      baselineUrls: baselineUrls ? Array.from(baselineUrls) : null
    };
  });

  console.log('Adapter status check:', JSON.stringify(status, null, 2));
  process.exit(0);
}

testAdapterStatus().catch(console.error);
