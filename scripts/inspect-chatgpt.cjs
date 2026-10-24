const { chromium } = require('playwright-core');

(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const chatPage = browser.contexts()[0].pages().find((p) => p.url().includes('chatgpt.com'));
  if (!chatPage) {
    console.log('No chatgpt page');
    process.exit(1);
  }

  const info = await chatPage.evaluate(() => {
    const composer = document.querySelector(
      '#prompt-textarea, [data-testid="composer-input"], div[contenteditable="true"]'
    );
    const sendBtn = document.querySelector(
      'button[aria-label="Send"], button[data-testid="send-button"], [data-testid="fruitjuice-send-button"], button[aria-label*="Send" i]'
    );
    const stopBtn = document.querySelector(
      'button[aria-label="Stop" i], button[aria-label*="Stop" i], [data-testid="stop-button"]'
    );
    const turns = Array.from(document.querySelectorAll('[data-turn-key], [data-message-author-role], article')).map(
      (t) => ({
        tag: t.tagName,
        role: t.getAttribute('data-message-author-role'),
        turnKey: t.getAttribute('data-turn-key'),
        text: (t.innerText || '').slice(0, 80).replace(/\n+/g, ' ')
      })
    );
    return {
      composerText: composer ? composer.innerText || composer.value || '' : null,
      hasSendBtn: Boolean(sendBtn),
      sendBtnAria: sendBtn ? sendBtn.getAttribute('aria-label') : null,
      sendBtnDisabled: sendBtn ? sendBtn.disabled : null,
      hasStopBtn: Boolean(stopBtn),
      turnsCount: turns.length,
      lastTurns: turns.slice(-3)
    };
  });

  console.log('ChatGPT Info:', JSON.stringify(info, null, 2));
  await browser.close();
  process.exit(0);
})();
