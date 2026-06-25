/**
 * Config plugin: fix the `fmt` consteval build error on Xcode 26 (Apple Clang 21).
 *
 * Error: "call to consteval function fmt::basic_format_string<...> is not a
 * constant expression" in fmt's headers. The upstream RN fix is in RN 0.82.1+;
 * SDK 54 / RN 0.81 still ships the broken fmt, so we patch at build time.
 *
 * Strategy (version-INDEPENDENT, three overlapping mechanisms so we don't depend
 * on knowing the exact fmt version on the build machine):
 *   1. Compile the `fmt` AND `RCT-Folly` pods as C++17. consteval doesn't exist
 *      before C++20, so fmt's broken compile-time path is skipped entirely and it
 *      falls back to runtime/constexpr validation. This is the most reliable fix
 *      and does NOT depend on patching the right header.
 *   2. Define FMT_USE_CONSTEVAL=0 on those targets (belt).
 *   3. Patch whichever fmt header exists (base.h for fmt 10/11, core.h for fmt 9)
 *      to hard-disable the macro before fmt's own #ifndef guard (suspenders).
 *
 * (facebook/react-native#55601, expo/expo#44229.)
 */
const { withDangerousMod } = require("@expo/config-plugins");
const fs = require("node:fs");
const path = require("node:path");

const MARKER = "fmt consteval fix v2";

const PATCH = `
    # --- ${MARKER} (Xcode 26 / Apple Clang 21) ---
    # (1)+(2): force the fmt + RCT-Folly pods to C++17 with consteval off. Pre-C++20
    # has no consteval, so fmt never takes the path Xcode 26 rejects.
    installer.pods_project.targets.each do |t|
      if ['fmt', 'RCT-Folly'].include?(t.name)
        t.build_configurations.each do |bc|
          bc.build_settings['CLANG_CXX_LANGUAGE_STANDARD'] = 'c++17'
          defs = bc.build_settings['GCC_PREPROCESSOR_DEFINITIONS'] || ['$(inherited)']
          defs = [defs] unless defs.is_a?(Array)
          defs << 'FMT_USE_CONSTEVAL=0' unless defs.include?('FMT_USE_CONSTEVAL=0')
          bc.build_settings['GCC_PREPROCESSOR_DEFINITIONS'] = defs
        end
        Pod::UI.puts "[withFmtConstevalFix] set C++17 + FMT_USE_CONSTEVAL=0 on #{t.name}"
      end
    end
    # (3): also hard-disable the macro in whichever fmt header exists.
    fmt_dir = installer.sandbox.pod_dir('fmt')
    if fmt_dir && File.directory?(fmt_dir)
      ['base.h', 'core.h'].each do |header|
        fmt_header = File.join(fmt_dir, 'include', 'fmt', header)
        next unless File.exist?(fmt_header)
        src = File.read(fmt_header)
        next unless src.include?('FMT_USE_CONSTEVAL')
        next if src.include?('CHAIRBACK_FMT_OFF')
        out = src.sub(
          /#\\s*ifndef\\s+FMT_USE_CONSTEVAL/,
          "// CHAIRBACK_FMT_OFF\\n#ifndef FMT_USE_CONSTEVAL\\n#  define FMT_USE_CONSTEVAL 0\\n#endif\\n#ifndef FMT_USE_CONSTEVAL"
        )
        if out != src
          File.chmod(0644, fmt_header)
          File.write(fmt_header, out)
          Pod::UI.puts "[withFmtConstevalFix] patched fmt/#{header}"
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
      if (contents.includes(MARKER)) return cfg;
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
