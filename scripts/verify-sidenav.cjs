const { chromium } = require('playwright-core');
async function run() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const context = browser.contexts()[0];
  const flowPage = context.pages().find((p) => p.url().includes('flow.google.com/project'));
  const testExcluded = await flowPage.evaluate(() => {
    const img = document.querySelector('img[src*="flow-content.google"]');
    const excludedWithSidenav = '.boqOnegoogleliteOgbOneGoogleBar, #gb, mat-sidenav, .sidenav, nav, header, aside, [role="navigation"], [role="menu"], [data-testid*="composer"], footer, .composer';
    const excludedWithoutSidenav = '.boqOnegoogleliteOgbOneGoogleBar, #gb, mat-sidenav:not(.mat-sidenav-container), .mat-drawer:not(.mat-drawer-container), nav, header, aside, [role="navigation"], [role="menu"], [data-testid*="composer"], footer, .composer';
    const matchEl = img ? img.closest(excludedWithSidenav) : null;
    return {
      imgFound: Boolean(img),
      closestWithSidenav: Boolean(matchEl),
      matchedElementWithSidenav: matchEl ? matchEl.tagName + '.' + matchEl.className : null,
      closestWithoutSidenav: img ? Boolean(img.closest(excludedWithoutSidenav)) : null
    };
  });
  console.log(testExcluded);
  process.exit(0);
}
run();
