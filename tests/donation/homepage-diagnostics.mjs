import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function assertWithHomeDiagnostics(page, outputDir, width, stage, assertion) {
  const snapshot = await page.evaluate(() => {
    const rect = element => {
      if (!element) return null;
      const box = element.getBoundingClientRect();
      return {
        x: box.x,
        y: box.y,
        top: box.top,
        right: box.right,
        bottom: box.bottom,
        left: box.left,
        width: box.width,
        height: box.height,
      };
    };
    const style = element => {
      if (!element) return null;
      const value = getComputedStyle(element);
      return {
        display: value.display,
        gridTemplateColumns: value.gridTemplateColumns,
        marginBlockStart: value.marginBlockStart,
        marginBlockEnd: value.marginBlockEnd,
        paddingBlockStart: value.paddingBlockStart,
        paddingBlockEnd: value.paddingBlockEnd,
        fontSize: value.fontSize,
        lineHeight: value.lineHeight,
      };
    };
    const main = document.querySelector('main.home-redesign');
    const footer = document.querySelector('body.homepage-v2 > footer, footer');
    const sections = [...(main?.children ?? [])].map((element, index) => ({
      index,
      id: element.id || null,
      className: element.className,
      box: rect(element),
      style: style(element),
    }));
    const latestItems = [...(main?.querySelectorAll('.latest-item:not([hidden])') ?? [])].map((item, index) => ({
      index,
      id: item.dataset.latestId ?? null,
      lead: item.classList.contains('is-lead'),
      item: rect(item),
      media: rect(item.querySelector('[data-latest-media]')),
      copy: rect(item.querySelector('.latest-copy')),
      itemStyle: style(item),
    }));
    const footerGrid = footer?.querySelector('.footer-grid');
    const footerBottom = footer?.querySelector('.footer-bottom');
    return {
      viewport: { width: innerWidth, height: innerHeight, scrollY },
      document: { scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight },
      sections,
      services: rect(main?.querySelector('.home-service-band')),
      latestItems,
      footer: {
        box: rect(footer),
        grid: rect(footerGrid),
        columns: [...(footerGrid?.children ?? [])].map((element, index) => ({ index, box: rect(element) })),
        bottom: rect(footerBottom),
        style: style(footer),
      },
    };
  });
  const jsonPath = join(outputDir, `homepage-geometry-${stage}-${width}.json`);
  await mkdir(outputDir, { recursive: true });
  await writeFile(jsonPath, JSON.stringify(snapshot, null, 2));

  try {
    return await assertion(snapshot);
  } catch (error) {
    const screenshotPath = join(outputDir, `homepage-failure-${stage}-${width}.png`);
    try {
      await page.screenshot({ path: screenshotPath, fullPage: true });
      snapshot.failureScreenshot = screenshotPath.split('/').at(-1);
    } catch (screenshotError) {
      snapshot.failureScreenshotError = String(screenshotError);
    }
    snapshot.failure = String(error);
    await writeFile(jsonPath, JSON.stringify(snapshot, null, 2));
    throw error;
  }
}
