const { chromium } = require('playwright-core');

(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const context = browser.contexts()[0];
  const extPage = context.pages().find((p) =>
    p.url().includes('chrome-extension://pkpgpjlimgpnbggiecpacnmoopnamhhh')
  );
  const chatPage = context.pages().find((p) => p.url().includes('chatgpt.com'));

  if (extPage) {
    const extStatus = await extPage.evaluate(() => {
      const chips = Array.from(
        document.querySelectorAll('.status-chip, .badge, [class*="status"]')
      ).map((c) => c.textContent.trim());
      const friendlyStatus = Array.from(
        document.querySelectorAll('.task-friendly-status, [class*="friendly"]')
      ).map((f) => f.textContent.trim());
      const body = document.body.innerText.replace(/\s+/g, ' ').slice(0, 600);
      return { chips, friendlyStatus, body };
    });
    console.log('EXT STATUS:', JSON.stringify(extStatus, null, 2));
  }

  if (chatPage) {
    const chatStatus = await chatPage.evaluate(() => {
      const turns = Array.from(document.querySelectorAll('[data-turn-key]')).map((t) => {
        const imgs = Array.from(t.querySelectorAll('img')).map((i) => ({
          src: i.src.slice(0, 80),
          alt: i.alt,
          w: i.width,
          h: i.height
        }));
        const buttons = Array.from(t.querySelectorAll('button')).map((b) => ({
          text: b.innerText.trim(),
          aria: b.getAttribute('aria-label'),
          testid: b.getAttribute('data-testid')
        }));
        return {
          key: t.getAttribute('data-turn-key'),
          text: (t.innerText || '').slice(0, 100).replace(/\s+/g, ' '),
          imgs,
          buttons
        };
      });
      const modals = Array.from(document.querySelectorAll('[role="dialog"], [data-testid*="modal"], [data-testid*="viewer"]')).map((m) => ({
        tag: m.tagName,
        aria: m.getAttribute('aria-label'),
        buttons: Array.from(m.querySelectorAll('button')).map((b) => b.getAttribute('aria-label') || b.innerText)
      }));
      return { turns, modals };
    });
    console.log('CHATGPT STATUS:', JSON.stringify(chatStatus, null, 2));
  }

  await browser.close();
  process.exit(0);
})();
