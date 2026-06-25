/**
 * Config plugin: fix the `fmt` consteval build error on Xcode 26.x.
 *
 * Xcode 26's stricter Clang rejects fmt's compile-time format-string checking:
 *   "call to consteval function fmt::basic_format_string<...> is not a constant
 *    expression"
 * (facebook/react-native#55601, expo/expo#44229).
 *
 * The RELIABLE fix is to disable fmt's consteval path at its SOURCE - a Podfile
 * build-setting define (FMT_USE_CONSTEVAL=0) is not enough because fmt's own
 * header re-derives FMT_USE_CONSTEVAL from the compiler version. So this plugin
 * does two things during prebuild/pod-install:
 *   1. Patches the vendored fmt header(s) to hard-set FMT_USE_CONSTEVAL 0.
 *   2. Also adds the post_install build-setting define as a belt-and-suspenders.
 *
 * Runs in the `ios` dangerous mod AFTER prebuild has generated the Podfile, and
 * patches the header the pod install will copy. Remove once RN/Expo ship an fmt
 * that compiles cleanly on Xcode 26.
 */
const { withDangerousMod } = require("@expo/config-plugins");
const fs = require("fs");
const path = require("path");

const POST_INSTALL_HOOK = `
  # --- BEGIN fmt consteval fix (Xcode 26) ---
  # Hard-disable fmt's consteval in its vendored headers (build-setting defines
  # alone are overridden by fmt's own version detection), and force C++17 on the
  # fmt / RCT-Folly pods.
  fmt_headers = Dir.glob(File.join(installer.sandbox.root, '**', 'fmt', 'include', 'fmt', '*.h'))
  fmt_headers.each do |h|
    text = File.read(h)
    patched = text.gsub(/#\\s*define\\s+FMT_USE_CONSTEVAL\\s+1/, '#define FMT_USE_CONSTEVAL 0')
    File.write(h, patched) if patched != text
  end
  installer.pods_project.targets.each do |target|
    if ['fmt', 'RCT-Folly'].include?(target.name)
      target.build_configurations.each do |config|
        config.build_settings['CLANG_CXX_LANGUAGE_STANDARD'] = 'c++17'
        config.build_settings['GCC_PREPROCESSOR_DEFINITIONS'] ||= ['$(inherited)']
        config.build_settings['GCC_PREPROCESSOR_DEFINITIONS'] << 'FMT_USE_CONSTEVAL=0'
      end
    end
  end
  # --- END fmt consteval fix ---
`;

module.exports = function withFmtConstevalFix(config) {
  return withDangerousMod(config, [
    "ios",
    (cfg) => {
      const podfile = path.join(cfg.modRequest.platformProjectRoot, "Podfile");
      let contents = fs.readFileSync(podfile, "utf8");
      if (!contents.includes("fmt consteval fix")) {
        if (contents.includes("post_install do |installer|")) {
          contents = contents.replace(
            "post_install do |installer|",
            "post_install do |installer|\n" + POST_INSTALL_HOOK,
          );
        } else {
          contents += `\npost_install do |installer|\n${POST_INSTALL_HOOK}\nend\n`;
        }
        fs.writeFileSync(podfile, contents);
      }
      return cfg;
    },
  ]);
};
