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

module.exports = config;
