const { chromium } = require('playwright-core');

async function debugButton() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const context = browser.contexts()[0];
  const flowPage = context.pages().find((p) => p.url().includes('flow.google.com/project'));

  const debugInfo = await flowPage.evaluate(() => {
    const genBtn = document.querySelector(
      'button.generate-icon-button, button[aria-label*="Start generation" i]'
    );
    if (!genBtn) return 'Button not found by querySelector!';
    return {
      tagName: genBtn.tagName,
      className: genBtn.className,
      ariaLabel: genBtn.getAttribute('aria-label'),
      disabled: genBtn.disabled,
      ariaDisabled: genBtn.getAttribute('aria-disabled'),
      textContent: genBtn.textContent.trim(),
      offsetWidth: genBtn.offsetWidth,
      offsetHeight: genBtn.offsetHeight,
      parentElement: genBtn.parentElement?.tagName,
      closestDialog: Boolean(genBtn.closest('[role="dialog"], .modal, .dialog')),
      closestForm: Boolean(genBtn.closest('form'))
    };
  });

  console.log('Generate button inspection on live Flow page:');
  console.log(JSON.stringify(debugInfo, null, 2));
  process.exit(0);
}

debugButton().catch(console.error);
