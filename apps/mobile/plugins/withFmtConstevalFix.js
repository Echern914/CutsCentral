/**
 * Config plugin: make the bundled `fmt` library (v11.0.2, pulled in by React
 * Native 0.76) compile under Xcode 26's Clang.
 *
 * WHY: Apple requires App Store builds to use Xcode 26+ (as of Apr 28, 2026).
 * Xcode 26's Clang strictly enforces `consteval`, and fmt 11.0.2's
 * `FMT_STRING` / `basic_format_string` path then fails to compile with:
 *   "call to consteval function ... is not a constant expression"
 * (errors in fmt/format-inl.h, target 'fmt' from project 'Pods').
 *
 * WHY A SOURCE PATCH (not a -D flag): fmt 11.0.2's base.h has NO
 * `#ifndef FMT_USE_CONSTEVAL` override hook — it *unconditionally* redefines
 * FMT_USE_CONSTEVAL from compiler detection, so any `-DFMT_USE_CONSTEVAL=0`
 * build setting is clobbered by the header. On Xcode 26 the detection lands on
 * `#elif defined(__cpp_consteval) -> #define FMT_USE_CONSTEVAL 1`. We instead
 * rewrite those `define ... 1` lines to `0` directly in the downloaded header.
 * This is the same state Apple's older clang selected (see the
 * `__apple_build_version__ < 14000029` branch), so it is a known-safe config.
 *
 * HOW: a Podfile `post_install` hook patches Pods/fmt/include/fmt/base.h. It
 * runs after CocoaPods downloads fmt but before Xcode compiles it.
 *
 * REMOVE THIS once Expo SDK is upgraded to a React Native whose fmt compiles
 * cleanly on Xcode 26.
 */
const { withDangerousMod } = require("@expo/config-plugins");
const fs = require("fs");
const path = require("path");

const MARKER = "fmt consteval fix";

const INJECTION = `
    # --- ${MARKER} (patch fmt 11.0.2 base.h so it builds on Xcode 26) ---
    fmt_base_h = File.join(installer.sandbox.root.to_s, 'fmt', 'include', 'fmt', 'base.h')
    if File.exist?(fmt_base_h)
      original = File.read(fmt_base_h)
      patched = original.gsub('#  define FMT_USE_CONSTEVAL 1', '#  define FMT_USE_CONSTEVAL 0')
      if patched != original
        File.write(fmt_base_h, patched)
        Pod::UI.puts '[${MARKER}] Disabled FMT_USE_CONSTEVAL in fmt/base.h'
      end
    else
      Pod::UI.warn '[${MARKER}] fmt/base.h not found at ' + fmt_base_h + ' - fmt may fail to build on Xcode 26'
    end
    # --- end ${MARKER} ---
`;

module.exports = function withFmtConstevalFix(config) {
  return withDangerousMod(config, [
    "ios",
    async (cfg) => {
      const podfile = path.join(cfg.modRequest.platformProjectRoot, "Podfile");
      let contents = fs.readFileSync(podfile, "utf8");
      if (!contents.includes(MARKER)) {
        // Insert at the top of the existing `post_install do |installer|` block
        // that Expo generates. fmt is already downloaded by this point.
        contents = contents.replace(
          /post_install do \|installer\|/,
          (match) => match + "\n" + INJECTION
        );
        fs.writeFileSync(podfile, contents);
      }
      return cfg;
    },
  ]);
};
