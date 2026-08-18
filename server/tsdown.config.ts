import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  format: "esm",
  platform: "node",
  target: "node24",
  deps: {
    alwaysBundle: [
      /^@browsight\/shared(?:\/|$)/,
      /^@modelcontextprotocol\/sdk(?:\/|$)/,
      /^zod(?:\/|$)/,
    ],
    onlyBundle: false,
  },
  dts: false,
  clean: true,
});
