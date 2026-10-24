const { chromium } = require('playwright-core');
const fs = require('fs');

(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const chatPage = browser.contexts()[0].pages().find((p) => p.url().includes('chatgpt.com'));

  const initialDownloads = fs.readdirSync('C:/Users/assem/Downloads');

  console.log('Triggering anchor click on blob image in ChatGPT page...');
  const res = await chatPage.evaluate(() => {
    // Find the last blob image (the dragon)
    const blobImgs = Array.from(document.querySelectorAll('img')).filter(i => i.src.startsWith('blob:'));
    if (blobImgs.length === 0) return { error: 'No blob images found' };
    const targetImg = blobImgs[blobImgs.length - 1];

    const a = document.createElement('a');
    a.href = targetImg.src;
    a.download = 'Direct_Blob_Dragon_Test.png';
    document.body.appendChild(a);
    a.click();
    a.remove();
    return { success: true, src: targetImg.src };
  });

  console.log('Evaluate result:', res);
  await chatPage.waitForTimeout(2000);

  const currentDownloads = fs.readdirSync('C:/Users/assem/Downloads');
  const newFiles = currentDownloads.filter(f => !initialDownloads.includes(f));
  console.log('New files in Downloads:', newFiles);

  await browser.close();
  process.exit(0);
})();
