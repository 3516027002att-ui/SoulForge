import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = resolve(fileURLToPath(new URL(".", import.meta.url)));
const repoRoot = resolve(here, "../..");
const htmlPath = resolve(here, "portfolio.html");
const outputDir = resolve(repoRoot, "output", "pdf");
const outputPath = resolve(outputDir, "soulforge-ai-mod-portfolio.pdf");

const waitForPageBackgrounds = async (page) => {
  await page.evaluate(async () => {
    const urls = [...new Set(
      [...document.querySelectorAll(".page")]
        .map((element) => getComputedStyle(element).backgroundImage.match(/url\(["']?(.*?)["']?\)/)?.[1])
        .filter(Boolean),
    )];
    await Promise.all(urls.map((url) => new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = resolve;
      image.onerror = () => reject(new Error(`failed to load page background: ${url}`));
      image.src = url;
    })));
  });
};

await mkdir(outputDir, { recursive: true });

const browserCandidates = [
  process.env.SOULFORGE_PDF_CHROME,
  "C:\\Users\\ASUS\\AppData\\Local\\ms-playwright\\chromium-1237\\chrome-win64\\chrome.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
].filter(Boolean);
const executablePath = browserCandidates.find((candidate) => existsSync(candidate));
const browser = await chromium.launch({
  headless: true,
  ...(executablePath ? { executablePath } : {}),
});
try {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
  });
  await page.goto("file:///" + htmlPath.replaceAll("\\", "/"), { waitUntil: "load" });
  await waitForPageBackgrounds(page);
  await page.emulateMedia({ media: "print" });
  const pageCount = await page.locator(".page").count();
  if (pageCount !== 12) {
    throw new Error("expected 12 portfolio pages, received " + pageCount);
  }
  await page.pdf({
    path: outputPath,
    printBackground: true,
    preferCSSPageSize: true,
    displayHeaderFooter: false,
    margin: { top: "0", right: "0", bottom: "0", left: "0" },
  });
  console.log(JSON.stringify({ outputPath, pageCount }, null, 2));
} finally {
  await browser.close();
}
