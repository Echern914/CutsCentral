// Metro config for this pnpm monorepo. Dependencies are hoisted to the repo-root
// node_modules (node-linker=hoisted), so Metro must resolve from BOTH the app and
// the workspace root. SDK 54's expo/metro-config handles most of this, but we add
// the workspace root explicitly so the EAS cloud build (fresh install) resolves
// the hoisted packages. This is the Expo-recommended monorepo shape.
const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");

const config = getDefaultConfig(projectRoot);

config.watchFolders = [projectRoot, workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(workspaceRoot, "node_modules"),
];

// Force a SINGLE copy of React (and react/jsx-runtime, react-dom) for the whole
// bundle. This monorepo is intentionally dual-React: the root node_modules holds
// React 18 (the web app needs it), while apps/mobile pins React 19 (required by
// RN 0.81 / SDK 54). Because react-native lives in the ROOT node_modules, its
// internal `require('react')` would otherwise resolve the root React 18 - a
// mismatched, dual-React bundle that breaks on EAS. We pin every react/react-dom
// request to apps/mobile's copy by resolving it as if from the app root.
const pinnedReactOrigin = path.join(projectRoot, "index.js");
const defaultResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (
    moduleName === "react" ||
    moduleName.startsWith("react/") ||
    moduleName === "react-dom" ||
    moduleName.startsWith("react-dom/")
  ) {
    return context.resolveRequest(
      { ...context, originModulePath: pinnedReactOrigin },
      moduleName,
      platform
    );
  }
  return (defaultResolveRequest ?? context.resolveRequest)(
    context,
    moduleName,
    platform
  );
};

module.exports = config;
