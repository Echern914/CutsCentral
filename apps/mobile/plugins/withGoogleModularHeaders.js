const { withDangerousMod } = require("@expo/config-plugins");
const fs = require("fs");
const path = require("path");

/**
 * GoogleSignIn 9.x (pulled by @react-native-google-signin) brings in AppCheckCore
 * - a SWIFT pod that depends on GoogleUtilities + RecaptchaInterop, which ship NO
 * module maps. Under Expo's default static-library build, a Swift pod importing
 * non-modular pods fails `pod install` with:
 *
 *   [!] The following Swift pods cannot yet be integrated as static libraries:
 *       The Swift pod `AppCheckCore` depends upon `GoogleUtilities` and
 *       `RecaptchaInterop`, which do not define modules. ... set
 *       use_modular_headers! ... or :modular_headers => true ...
 *
 * Expo already enables modular headers for GoogleSignIn itself, but not for these
 * transitive Google/GTM pods. We declare `:modular_headers => true` for them
 * (TARGETED, not a global use_modular_headers! - which can disturb the React/Expo
 * pods - and NOT use_frameworks, which breaks RNScreens on SDK 54). No version is
 * pinned: we only add the attribute to the version CocoaPods already resolves.
 */
const MARKER = "# >>> ChairBack: modular headers for Google transitive pods";

// The Google/GTM/AppCheck pods GoogleSignIn 9.x drags in that Expo does NOT
// already make modular. GoogleSignIn itself is omitted (Expo handles it; a second
// declaration would be a duplicate).
const PODS = [
  "GoogleUtilities",
  "RecaptchaInterop",
  "AppCheckCore",
  "GTMSessionFetcher",
  "GTMAppAuth",
  "AppAuth",
];

module.exports = function withGoogleModularHeaders(config) {
  return withDangerousMod(config, [
    "ios",
    (cfg) => {
      const podfile = path.join(cfg.modRequest.platformProjectRoot, "Podfile");
      let contents = fs.readFileSync(podfile, "utf8");
      if (contents.includes(MARKER)) return cfg; // idempotent

      const block =
        "\n  " +
        MARKER +
        "\n" +
        PODS.map((p) => `  pod '${p}', :modular_headers => true`).join("\n") +
        "\n";

      // Insert inside the app target, right after `use_expo_modules!`.
      const anchor = "use_expo_modules!";
      const idx = contents.indexOf(anchor);
      if (idx === -1) {
        throw new Error(
          "withGoogleModularHeaders: could not find `use_expo_modules!` in the Podfile",
        );
      }
      const insertAt = contents.indexOf("\n", idx) + 1;
      contents = contents.slice(0, insertAt) + block + contents.slice(insertAt);
      fs.writeFileSync(podfile, contents);
      return cfg;
    },
  ]);
};
