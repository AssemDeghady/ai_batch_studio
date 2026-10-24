const { chromium } = require('playwright-core');

async function run() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const context = browser.contexts()[0];
  const chatgptPage = context.pages().find((p) => p.url().includes('chatgpt.com'));

  await chatgptPage.bringToFront();

  // Test what happens when we click sendButton via page.click vs DOM click vs Enter key
  const clickRes = await chatgptPage.evaluate(() => {
    const btn = document.querySelector('button[aria-label*="Send" i], button[data-testid="send-button"]');
    if (!btn) return 'No send button found';
    const rect = btn.getBoundingClientRect();
    return {
      tagName: btn.tagName,
      aria: btn.getAttribute('aria-label'),
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      disabled: btn.disabled,
      className: btn.className
    };
  });
  console.log('Send button details:', clickRes);

  // Try clicking it with Playwright (genuine OS-level mouse event)
  console.log('Clicking send button with Playwright...');
  await chatgptPage.click('button[aria-label*="Send" i]');
  await chatgptPage.waitForTimeout(2000);

  const afterState = await chatgptPage.evaluate(() => {
    const composer = document.querySelector('#prompt-textarea, [data-testid="composer-input"], div[contenteditable="true"]');
    const turns = document.querySelectorAll('[data-message-author-role="assistant"], .agent-turn');
    return {
      composerText: composer ? composer.textContent : null,
      turnsCount: turns.length
    };
  });

  console.log('After Playwright click:', afterState);
  process.exit(0);
}

run().catch(console.error);
