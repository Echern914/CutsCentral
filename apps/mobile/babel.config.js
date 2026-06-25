// REQUIRED for the app to bundle/mount at all. Without babel-preset-expo, Metro
// can't apply the expo-router file-routing transform or resolve the `@/*` path
// alias used across the app (e.g. `@/src/config`), so a native build can ship a
// bundle that never mounts a route - the app sits on the splash/spinner forever
// with no JS running (and thus no error screen). This was the root cause of the
// permanent launch hang.
module.exports = function (api) {
  api.cache(true);
  return {
    presets: ["babel-preset-expo"],
  };
};
