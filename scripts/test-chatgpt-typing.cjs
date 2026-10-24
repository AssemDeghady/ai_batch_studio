const { chromium } = require('playwright-core');

async function run() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const context = browser.contexts()[0];
  const chatgptPage = context.pages().find((p) => p.url().includes('chatgpt.com'));

  // Enter text into the composer
  await chatgptPage.evaluate(() => {
    const composer = document.querySelector('#prompt-textarea, [data-testid="composer-input"], div[contenteditable="true"]');
    if (composer) {
      composer.focus();
      if (composer.tagName === 'DIV') {
        composer.innerHTML = '<p>Hello world test</p>';
      } else {
        composer.value = 'Hello world test';
      }
      composer.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, data: 'Hello world test' }));
      composer.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });

  await chatgptPage.waitForTimeout(500);

  // Check what buttons exist now
  const btns = await chatgptPage.evaluate(() => {
    return Array.from(document.querySelectorAll('button')).map((b) => ({
      aria: b.getAttribute('aria-label'),
      testId: b.getAttribute('data-testid'),
      disabled: b.disabled,
      text: b.textContent?.trim().slice(0, 30),
      className: b.className.slice(0, 50)
    })).filter(b => b.aria || b.testId || b.text);
  });

  console.log('Buttons after typing into composer:');
  console.log(btns.filter(b => (b.aria && /send|voice|submit/i.test(b.aria)) || (b.testId && /send/i.test(b.testId))));

  process.exit(0);
}

run().catch(console.error);
