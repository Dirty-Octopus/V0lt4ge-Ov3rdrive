import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  testMatch: "**/*.spec.js",
  timeout: 40_000,
  use: {
    baseURL: "http://localhost:5173",
    channel: "chrome",
    headless: true,
    viewport: { width: 1440, height: 900 },
  },
  webServer: {
    command: "npm run dev",
    url: "http://localhost:5173",
    reuseExistingServer: true,
  },
});
