import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const urlMod = require("node:url");
const originalFileURLToPath = urlMod.fileURLToPath;

const fakeScriptPath = process.env.MOCK_CACHE_NODE
  ? join(process.cwd(), "scratch", ".cache", "node", "package", "dist", "setup.ts")
  : join(process.cwd(), "scratch", "_npx", "package", "dist", "setup.ts");

urlMod.fileURLToPath = (url: string | URL) => {
  const stack = new Error().stack;
  if (fakeScriptPath && stack && stack.includes("setup.ts:84")) {
    return fakeScriptPath;
  }
  return originalFileURLToPath(url);
};

// Restore the original fileURLToPath on exit to ensure correct coverage path resolution
process.on("exit", () => {
  urlMod.fileURLToPath = originalFileURLToPath;
});

// Mock process.argv[1] to be undefined during evaluation of setup.ts to cover isMain false branch
const originalArgv1 = process.argv[1];
if (!process.env.IS_CHILD) {
  process.argv[1] = undefined as unknown as string;
}

const netMod = require("node:net");
const originalCreateServer = netMod.createServer;

export function restoreArgv1() {
  if (!process.env.IS_CHILD) {
    process.argv[1] = originalArgv1 as string;
  }
}

netMod.createServer = (...args: Parameters<typeof originalCreateServer>) => {
  if (process.env.MOCK_SOCKET_ADDRESS === "string") {
    const srv = originalCreateServer(...args);
    srv.address = () => "some-unix-socket-string";
    return srv;
  }
  if (process.env.MOCK_SOCKET_ADDRESS === "null") {
    const srv = originalCreateServer(...args);
    srv.address = () => null;
    return srv;
  }
  return originalCreateServer(...args);
};
