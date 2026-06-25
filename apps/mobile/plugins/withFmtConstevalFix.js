/**
 * Config plugin: fix the `fmt` consteval build error on Xcode 26 (Apple Clang 21).
 *
 * Error: "call to consteval function fmt::basic_format_string<...> is not a
 * constant expression" - Xcode 26's strict Clang rejects the compile-time format
 * checking in the fmt 11.x that React Native 0.76 (RCT-Folly) vendors. The fix
 * is NOT a build-setting define: fmt/base.h re-derives FMT_USE_CONSTEVAL=1 from
 * the compiler version, clobbering any -D define. We must patch the HEADER SOURCE
 * to hard-disable it. (facebook/react-native#55601, expo/expo#44229.)
 *
 * Mechanism (confirmed working): inject a Ruby patch into the prebuild-generated
 * Podfile's post_install, AFTER react_native_post_install runs (so pods are on
 * disk), and BEFORE Xcode compiles them. The patch rewrites the FMT_USE_CONSTEVAL
 * toggle in the fmt pod's base.h to 0.
 */
const { withDangerousMod } = require("@expo/config-plugins");
const fs = require("node:fs");
const path = require("node:path");

const MARKER = "fmt consteval base.h patch";

// Ruby injected into the Podfile post_install block.
const PATCH = `
    # --- ${MARKER} (Xcode 26 / Apple Clang 21) ---
    fmt_base = File.join(installer.sandbox.pod_dir('fmt'), 'include', 'fmt', 'base.h')
    if File.exist?(fmt_base)
      src = File.read(fmt_base)
      # fmt derives this from the compiler; force it off so the consteval path
      # (rejected by Xcode 26) is never taken.
      out = src.gsub(/#\\s*define\\s+FMT_USE_CONSTEVAL\\s+1/, '#define FMT_USE_CONSTEVAL 0')
      if out != src
        File.chmod(0644, fmt_base)
        File.write(fmt_base, out)
        Pod::UI.puts '[withFmtConstevalFix] patched fmt/base.h FMT_USE_CONSTEVAL -> 0'
      else
        Pod::UI.puts '[withFmtConstevalFix] FMT_USE_CONSTEVAL define not found (already patched or moved)'
      end
    else
      Pod::UI.puts "[withFmtConstevalFix] fmt base.h not found at #{fmt_base}"
    end
    # Belt-and-suspenders: also compile fmt / RCT-Folly as C++17 with the define
    # off, in case the header layout differs in some pod version.
    installer.pods_project.targets.each do |t|
      if ['fmt', 'RCT-Folly'].include?(t.name)
        t.build_configurations.each do |bc|
          bc.build_settings['CLANG_CXX_LANGUAGE_STANDARD'] = 'c++17'
          bc.build_settings['GCC_PREPROCESSOR_DEFINITIONS'] ||= ['$(inherited)']
          bc.build_settings['GCC_PREPROCESSOR_DEFINITIONS'] << 'FMT_USE_CONSTEVAL=0'
        end
      end
    end
    # --- end ${MARKER} ---
`;

module.exports = function withFmtConstevalFix(config) {
  return withDangerousMod(config, [
    "ios",
    (cfg) => {
      const podfile = path.join(cfg.modRequest.platformProjectRoot, "Podfile");
      if (!fs.existsSync(podfile)) return cfg;
      let contents = fs.readFileSync(podfile, "utf8");
      if (contents.includes(MARKER)) return cfg; // idempotent

      // Insert RIGHT AFTER the react_native_post_install(...) call inside the
      // existing `post_install do |installer|` block, so pods (incl. fmt) are
      // already installed on disk when we patch the header.
      const rnPostInstall = /react_native_post_install\([\s\S]*?\)\n/;
      if (rnPostInstall.test(contents)) {
        contents = contents.replace(rnPostInstall, (m) => m + PATCH);
      } else if (contents.includes("post_install do |installer|")) {
        // Fallback: no react_native_post_install match - prepend into the block.
        contents = contents.replace(
          "post_install do |installer|",
          "post_install do |installer|\n" + PATCH,
        );
      } else {
        // No post_install block at all - add one.
        contents += `\npost_install do |installer|\n${PATCH}\nend\n`;
      }
      fs.writeFileSync(podfile, contents);
      return cfg;
    },
  ]);
};
