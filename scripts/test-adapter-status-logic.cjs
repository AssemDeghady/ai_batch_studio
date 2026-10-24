const { chromium } = require('playwright-core');

async function testGetTaskStatusLogic() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const context = browser.contexts()[0];
  const flowPage = context.pages().find((p) => p.url().includes('flow.google.com/project'));

  const result = await flowPage.evaluate(() => {
    const isElementVisible = (el) => Boolean(el.offsetWidth > 0 && el.offsetHeight > 0);

    // 1. Error check
    const errorEl = document.querySelector(
      '[data-testid="flow-error-banner"], .flow-error-message, [role="alert"][data-severity="error"]'
    );

    // 2. Spinner check
    const spinnerEls = Array.from(
      document.querySelectorAll(
        '[data-testid="flow-generating-indicator"], .flow-generation-progress, [role="progressbar"], [aria-busy="true"], mat-progress-spinner, mat-spinner, md-circular-progress, md-linear-progress, [class*="shimmer" i], [class*="skeleton" i]'
      )
    ).filter(isElementVisible);

    // 3. Status text check
    const statusEls = Array.from(
      document.querySelectorAll(
        '[role="status"], [aria-live], .flow-status, [class*="progress" i], [class*="loading" i], [class*="generating" i]'
      )
    );
    const hasActiveProgressText = statusEls.some((el) => {
      if (!isElementVisible(el)) return false;
      const txt = (el.textContent || '').trim();
      return (
        /^\d{1,3}%$/.test(txt) ||
        /^(?:generating|creating|queuing|queued|rendering)/i.test(txt)
      );
    });

    // 4. Baseline outputs
    const baselineAttr = document.body.getAttribute('data-batch-studio-baseline-outputs');
    const rawUrlsAttr = document.body.getAttribute('data-batch-studio-baseline-urls');
    let baselineUrls = null;
    if (rawUrlsAttr) {
      try {
        const parsed = JSON.parse(rawUrlsAttr);
        if (Array.isArray(parsed)) baselineUrls = new Set(parsed);
      } catch {}
    }

    // Output elements
    const allOutputs = Array.from(
      document.querySelectorAll('img[src*="flow-content.google"], aisandbox-root img[src], main img[src]')
    ).filter(img => !img.closest('.boqOnegoogleliteOgbOneGoogleBar, #gb, mat-sidenav, nav, header, aside, footer, .composer'));

    let newOutputElements = baselineUrls
      ? allOutputs.filter((el) => {
          const src = (el.currentSrc || el.src || '').trim();
          return Boolean(src) && !baselineUrls.has(src);
        })
      : [];

    const baseline = baselineAttr ? Number(baselineAttr) : 0;
    if (newOutputElements.length === 0 && allOutputs.length > baseline) {
      const newCount = allOutputs.length - baseline;
      newOutputElements = allOutputs.slice(0, newCount);
    }

    const hasLoadingImage = newOutputElements.some((el) => !el.complete);

    return {
      hasError: Boolean(errorEl),
      spinnerElsCount: spinnerEls.length,
      hasActiveProgressText,
      baselineAttr,
      baselineUrlsCount: baselineUrls ? baselineUrls.size : null,
      allOutputsCount: allOutputs.length,
      newOutputElementsCount: newOutputElements.length,
      newOutputElements: newOutputElements.map(i => i.src.slice(0, 80)),
      hasLoadingImage
    };
  });

  console.log('getTaskStatus evaluation:', JSON.stringify(result, null, 2));
  process.exit(0);
}

testGetTaskStatusLogic().catch(console.error);
