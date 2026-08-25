/**
 * Installing the built extension where Chrome loads it from.
 *
 * Chrome loads an unpacked extension from a fixed path and keeps using that path forever, so it
 * cannot point at the package directory: under `npx` that lives in npm's cache, which is
 * version-specific and garbage-collected. The extension also needs `connection.json` (host, port,
 * token) inside its own folder, because the service worker can only read files bundled with it, and
 * a per-machine secret has no business in a shared npm cache.
 *
 * So `extension/dist` is the build artifact and `~/.browsight/extension` is the install. This module
 * is the single owner of the step between them: `setup` installs, `build` refreshes an existing
 * install. Nothing else copies these files, so the two can never drift silently again.
 *
 * The source directory is a parameter so these can be exercised without a build having run. CI runs
 * the tests before the build, so anything reaching for real build output fails on a fresh checkout.
 */
import { cpSync, existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { EXTENSION_DIST_SRC, extensionHome } from "./paths.ts";

/** The file compared to decide whether an install is current. */
const MARKER_FILE = "content.js";

/** True once the extension has been installed, meaning Chrome has a path it can load. */
export function isExtensionInstalled(): boolean {
  return existsSync(join(extensionHome(), "manifest.json"));
}

/**
 * Copy the built extension over the install.
 *
 * `connection.json` is written by setup into the install directory and is absent from the build
 * output, so a recursive copy leaves it untouched.
 */
export function installExtension(from: string = EXTENSION_DIST_SRC): void {
  if (!existsSync(from)) {
    return;
  }
  mkdirSync(extensionHome(), { recursive: true });
  cpSync(from, extensionHome(), { recursive: true });
}

/**
 * Refresh an install that already exists, and do nothing otherwise.
 *
 * This is what `build` calls. On a fresh clone or in CI there is no install, so building stays a
 * pure repository operation and never creates files in a home directory. On a machine where
 * browsight is set up, one `npm run build` is enough for Chrome's next reload to pick the change up.
 */
export function refreshInstalledExtension(from: string = EXTENSION_DIST_SRC): boolean {
  if (!isExtensionInstalled()) {
    return false;
  }
  installExtension(from);
  return true;
}

/**
 * Whether Chrome is loading an older copy than the one that has been built.
 *
 * `npm run build` writes `extension/dist`, but Chrome loads the install. They are kept in step by
 * the postbuild step and by setup, so drift means one of those did not run, and the symptom is
 * baffling: the extension reloads and nothing changes, because the reloaded copy is the old one.
 */
export function installedExtensionIsStale(from: string = EXTENSION_DIST_SRC): boolean {
  const built = join(from, MARKER_FILE);
  const installed = join(extensionHome(), MARKER_FILE);
  if (!existsSync(built) || !existsSync(installed)) {
    return false;
  }
  return statSync(built).mtimeMs > statSync(installed).mtimeMs;
}
