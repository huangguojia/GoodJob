import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  timeout: 30_000,
  expect: { timeout: 8_000 },
  use: {
    baseURL: "http://127.0.0.1:5188",
    trace: "retain-on-failure"
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], channel: "chrome" }
    }
  ],
  webServer: [
    {
      command: "npm run dev --workspace backend",
      cwd: "..",
      url: "http://127.0.0.1:4188/api/health",
      reuseExistingServer: true,
      timeout: 20_000
    },
    {
      command: "npm run dev --workspace frontend",
      cwd: "..",
      url: "http://127.0.0.1:5188/",
      reuseExistingServer: true,
      timeout: 20_000
    }
  ]
});
