// REQUIRED in this pnpm monorepo. Dependencies are hoisted to the repo-root
// node_modules (node-linker=hoisted), so default Metro resolution - which only
// looks in apps/mobile/node_modules - can't find react / react-native / expo /
// expo-router and ships an empty/broken bundle that never mounts (the splash/
// spinner hang). Point Metro at BOTH the app and the workspace root.
const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");

const config = getDefaultConfig(projectRoot);

// Watch the whole monorepo so changes in shared packages are picked up.
config.watchFolders = [workspaceRoot];

// Resolve modules from the app first, then the hoisted workspace-root store.
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(workspaceRoot, "node_modules"),
];

// With a hoisted layout there's a single flat store at the root; disabling the
// hierarchical (walk-up) lookup makes resolution deterministic and avoids
// duplicate-package issues (two copies of react, etc.).
config.resolver.disableHierarchicalLookup = true;

module.exports = config;
