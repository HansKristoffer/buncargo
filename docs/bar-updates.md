# BuncargoBar updates

The CLI is the only updater. The app reads the registry and reports incompatible schema versions; it does not download or replace itself.

`buncargo dev` checks in the background and `buncargo bar update` runs an explicit update. Release discovery uses `bar-v*` tags, not GitHub's latest release, since CLI releases share this repository. Checks are cached in the machine state directory to avoid repeated API requests. Failed or asset-less releases do not replace the installed app.

An update verifies the checksum and registry compatibility before quitting or replacing the installed bundle. Registry schema changes must update the TypeScript and Swift fixtures together. See [menu bar usage](../menubar/README.md) and [releasing](releasing.md).
