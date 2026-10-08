import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { chromium } from "playwright";

// Reuse the disposable database and synthetic observations from preview:web.
const fixture = JSON.parse(
  await readFile(".test-artifacts/web/preview.json", "utf8"),
) as {
  uiUrl: string;
  credentials: { email: string; password: string };
};
const origin = new URL(fixture.uiUrl);
assert.equal(
  origin.hostname,
  "127.0.0.1",
  "Use the local preview fixture only",
);
assert.equal(fixture.credentials.email, "root@example.test");
const browser = await chromium.launch({
  headless: true,
  ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
    ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
    : {}),
});
try {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 824 },
    deviceScaleFactor: 4,
    colorScheme: "light",
  });
  const page = await context.newPage();
  await page.goto(new URL("/daily", origin).href);
  await page
    .getByLabel("Email", { exact: true })
    .fill(fixture.credentials.email);
  await page
    .getByLabel("Password", { exact: true })
    .fill(fixture.credentials.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL("**/daily");
  await page.getByRole("region", { name: "Daily summary" }).waitFor();
  await page
    .getByRole("region", { name: "Daily summary" })
    .getByText("1,460", { exact: true })
    .waitFor();
  await page.evaluate(() => document.fonts.ready);
  await mkdir("docs/assets", { recursive: true });
  for (const theme of ["light", "dark"] as const) {
    const toggle = page.getByRole("button", {
      name: `Appearance: switch to ${theme} theme`,
      exact: true,
    });
    if (await toggle.count()) await toggle.click();
    await page.waitForFunction(
      (expected) => document.documentElement.dataset.theme === expected,
      theme,
    );
    await page.screenshot({
      path: `docs/assets/dashboard-${theme}-4x.png`,
      type: "png",
      scale: "device",
      animations: "disabled",
    });
  }
  console.log(
    "Captured lossless 5120 × 3296 PNGs from the synthetic dashboard.",
  );
} finally {
  await browser.close();
}
