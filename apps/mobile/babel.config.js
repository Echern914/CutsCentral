// REQUIRED for the app to bundle/mount at all. Without babel-preset-expo, Metro
// can't apply the expo-router file-routing transform, so a native build can ship
// a bundle that never mounts a route - the app sits on the splash/spinner with
// no JS running (and thus no error screen). This was the launch-hang root cause.
// (The `@/*` path alias is resolved separately by Metro via tsconfig paths +
// baseUrl, not by this preset.)
module.exports = function (api) {
  api.cache(true);
  return {
    presets: ["babel-preset-expo"],
  };
};
