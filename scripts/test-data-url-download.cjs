const { chromium } = require('playwright-core');
const fs = require('fs');

(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const chatPage = browser.contexts()[0].pages().find((p) => p.url().includes('chatgpt.com'));
  const extPage = browser.contexts()[0].pages().find((p) =>
    p.url().includes('chrome-extension://pkpgpjlimgpnbggiecpacnmoopnamhhh')
  );

  const initialDownloads = fs.readdirSync('C:/Users/assem/Downloads');

  // Convert the last blob to a data URL inside the ChatGPT page
  console.log('Reading blob as data URL inside ChatGPT tab...');
  const dataUrl = await chatPage.evaluate(async () => {
    const blobImgs = Array.from(document.querySelectorAll('img')).filter((i) =>
      i.src.startsWith('blob:')
    );
    if (blobImgs.length === 0) return null;
    const targetImg = blobImgs[blobImgs.length - 1];

    const res = await fetch(targetImg.src);
    const blob = await res.blob();
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.readAsDataURL(blob);
    });
  });

  console.log('Data URL length:', dataUrl ? dataUrl.length : 'null');

  // Trigger download via extension's chrome.downloads
  console.log('Triggering chrome.downloads from extension page...');
  const dlResult = await extPage.evaluate(async (url) => {
    return new Promise((resolve, reject) => {
      chrome.downloads.download(
        {
          url: url,
          filename: 'Direct_Data_Dragon_Test.png',
          conflictAction: 'uniquify'
        },
        (downloadId) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve(downloadId);
          }
        }
      );
    });
  }, dataUrl);

  console.log('Download started with ID:', dlResult);
  await extPage.waitForTimeout(2000);

  const currentDownloads = fs.readdirSync('C:/Users/assem/Downloads');
  const newFiles = currentDownloads.filter((f) => !initialDownloads.includes(f));
  console.log('New files in Downloads:', newFiles);
  for (const nf of newFiles) {
    const stat = fs.statSync('C:/Users/assem/Downloads/' + nf);
    console.log(nf, stat.size, 'bytes');
  }

  await browser.close();
  process.exit(0);
})();
