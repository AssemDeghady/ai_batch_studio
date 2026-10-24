const { chromium } = require('playwright-core');
const fs = require('fs');

(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const chatPage = browser.contexts()[0].pages().find((p) => p.url().includes('chatgpt.com'));
  const extPage = browser.contexts()[0].pages().find((p) =>
    p.url().includes('chrome-extension://pkpgpjlimgpnbggiecpacnmoopnamhhh')
  );

  console.log('Fetching latest generated image blob from ChatGPT tab...');
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

  console.log('Data URL ready, length:', dataUrl?.length);

  console.log('Downloading via chrome.downloads without CDP interference...');
  const dlId = await extPage.evaluate(async (url) => {
    return new Promise((resolve, reject) => {
      chrome.downloads.download(
        {
          url,
          filename: 'ChatGPT_Majestic_Cybernetic_Dragon.png',
          conflictAction: 'uniquify'
        },
        (id) => {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve(id);
        }
      );
    });
  }, dataUrl);

  console.log('Download initiated with ID:', dlId);

  // Wait 2 seconds for download to complete on disk
  await new Promise((r) => setTimeout(r, 2000));

  // DISCONNECT over CDP (do NOT call browser.close() so Playwright does not delete files!)
  browser.disconnect();

  const targetPath = 'C:\\Users\\assem\\Downloads\\ChatGPT_Majestic_Cybernetic_Dragon.png';
  if (fs.existsSync(targetPath)) {
    const stat = fs.statSync(targetPath);
    console.log(`SUCCESS! File exists in Downloads: "${targetPath}" (${stat.size} bytes)`);
  } else {
    console.log('Checking recent in Downloads:');
    fs.readdirSync('C:\\Users\\assem\\Downloads').slice(-5).forEach((f) => console.log(f));
  }
  process.exit(0);
})();
