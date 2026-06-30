import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["setup.ts"],
  format: "esm",
  platform: "node",
  target: "node24",
  dts: false,
  clean: true,
});
