const strykerConfig = {
  mutate: [
    "lib/classroom-domain.ts:295-370",
    "lib/classroom-mobile-ranking.ts",
    "lib/classroom-observability.ts:22-100",
    "lib/classroom-observability.ts:129-179",
    "lib/classroom-privacy.ts",
  ],
  testRunner: "command",
  commandRunner: {
    command: "npm run test:mutation:unit",
  },
  coverageAnalysis: "off",
  concurrency: 2,
  timeoutMS: 15_000,
  thresholds: {
    high: 90,
    low: 90,
    break: 90,
  },
  reporters: ["clear-text", "progress", "json"],
  jsonReporter: {
    fileName: "evidence/mutation/mutation-report.json",
  },
  tempDirName: "tmp/stryker",
  cleanTempDir: true,
};

export default strykerConfig;
