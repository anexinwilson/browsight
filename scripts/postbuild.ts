/**
 * After a build, refresh the installed extension so Chrome's next reload picks the change up.
 *
 * Without this, `npm run build` updated `extension/dist` while Chrome kept loading the older copy in
 * `~/.browsight/extension`, and reloading the extension appeared to do nothing. On a machine with no
 * install (a fresh clone, CI) this is a no-op, so building never reaches outside the repository.
 */
import { refreshInstalledExtension } from "./extension-install.ts";
import { output } from "./output.ts";
import { extensionHome } from "./paths.ts";

if (refreshInstalledExtension()) {
  output.write(
    `[ok] refreshed the installed extension at ${extensionHome()}\n` +
      "     reload it in Chrome (Extensions > Manage extensions > reload) to pick this build up\n",
  );
}
