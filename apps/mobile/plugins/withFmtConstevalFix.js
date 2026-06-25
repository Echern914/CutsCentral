/**
 * Config plugin: fix the `fmt` consteval build error on Xcode 26 (Apple Clang 21).
 *
 * Error: "call to consteval function fmt::basic_format_string<...> is not a
 * constant expression" - Xcode 26's strict Clang rejects fmt's compile-time
 * format checking.
 *
 * KEY FACTS (verified against the installed sources, not assumed):
 *  - React Native 0.76.5 pins fmt to EXACTLY 9.1.0
 *    (react-native/third-party-podspecs/fmt.podspec: spec.version = "9.1.0").
 *  - In fmt 9.1.0 the macro lives in include/fmt/core.h (there is NO base.h
 *    until fmt 10) and is COMPUTED from the compiler version inside an #ifndef
 *    guard. A -D build define does NOT survive (fmt re-derives it). So we patch
 *    the HEADER SOURCE: inject a hard `#define FMT_USE_CONSTEVAL 0` immediately
 *    BEFORE fmt's own #ifndef guard, so the guard sees it already defined and
 *    skips the computed (consteval) path entirely. Version-agnostic: tries
 *    core.h (9.x) then base.h (10+).
 *  (facebook/react-native#55601, expo/expo#44229.)
 *
 * Mechanism: inject a Ruby patch into the prebuild-generated Podfile's
 * post_install block, anchored on the paren-free `post_install do |installer|`
 * line (NOT on react_native_post_install(...), whose multi-line/nested-paren
 * arg list breaks a lazy-paren regex and lands the patch mid-argument). Pod
 * sources are already on disk in the sandbox when post_install hooks run.
 */
const { withDangerousMod } = require("@expo/config-plugins");
const fs = require("node:fs");
const path = require("node:path");

const MARKER = "fmt consteval header patch";

const PATCH = `
    # --- ${MARKER} (Xcode 26 / Apple Clang 21) ---
    # RN 0.76.5 pins fmt 9.1.0 (macro in core.h; no base.h until fmt 10). Try
    # core.h first, then base.h, so this stays correct if the fmt pin bumps.
    fmt_dir = installer.sandbox.pod_dir('fmt')
    if fmt_dir && File.directory?(fmt_dir)
      ['core.h', 'base.h'].each do |header|
        fmt_header = File.join(fmt_dir, 'include', 'fmt', header)
        next unless File.exist?(fmt_header)
        src = File.read(fmt_header)
        next unless src.include?('FMT_USE_CONSTEVAL')
        next if src.include?('CHAIRBACK_FMT_CONSTEVAL_OFF')
        # Pre-define the macro to 0 right before fmt's own #ifndef guard so the
        # computed consteval path (rejected by Xcode 26) is never taken.
        out = src.sub(
          /#\\s*ifndef\\s+FMT_USE_CONSTEVAL/,
          "// CHAIRBACK_FMT_CONSTEVAL_OFF\\n#ifndef FMT_USE_CONSTEVAL\\n#  define FMT_USE_CONSTEVAL 0\\n#endif\\n#ifndef FMT_USE_CONSTEVAL"
        )
        if out != src
          File.chmod(0644, fmt_header)
          File.write(fmt_header, out)
          Pod::UI.puts "[withFmtConstevalFix] forced FMT_USE_CONSTEVAL 0 in fmt/#{header}"
        else
          Pod::UI.puts "[withFmtConstevalFix] fmt/#{header}: #ifndef FMT_USE_CONSTEVAL guard not found (layout changed?)"
        end
      end
    else
      Pod::UI.puts "[withFmtConstevalFix] fmt pod dir not found at #{fmt_dir.inspect}"
    end
    # Belt-and-suspenders: compile fmt / RCT-Folly as C++17 with the define off.
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

      // Anchor on the block opener (paren-free, exactly once). Do NOT match
      // react_native_post_install(...) - its multi-line/nested-paren arglist
      // breaks a lazy regex and injects mid-argument => broken Podfile.
      if (contents.includes("post_install do |installer|")) {
        contents = contents.replace(
          "post_install do |installer|",
          "post_install do |installer|\n" + PATCH,
        );
      } else {
        contents += `\npost_install do |installer|\n${PATCH}\nend\n`;
      }
      fs.writeFileSync(podfile, contents);
      return cfg;
    },
  ]);
};
