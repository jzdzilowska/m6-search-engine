import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage();

await page.goto('file:///usr/src/app/poster-draft-jesus.html', {
  waitUntil: 'networkidle'
});

await page.pdf({
  path: 'poster.pdf',
  width: '40in',
  height: '60in',
  printBackground: true,
  scale: 1
});

await browser.close();