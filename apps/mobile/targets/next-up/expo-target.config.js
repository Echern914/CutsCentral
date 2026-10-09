/**
 * The Lock Screen widget target ("Next: Sam · 2:30 PM · Fade").
 *
 * Generated into the Xcode project by @bacons/apple-targets at prebuild - but
 * only when NEXT_UP_WIDGET_ENABLED is set (app.config.ts), because a second
 * signed target with an App Group must not be the cost of a default build.
 *
 * The App Group is mirrored from the app's own entitlement, so the two can
 * never name different groups.
 *
 * @type {import('@bacons/apple-targets/app.plugin').ConfigFunction}
 */
module.exports = (config) => ({
  type: "widget",
  name: "NextUp",
  displayName: "Next up",
  // Lock Screen (accessory) widgets exist from iOS 16.
  deploymentTarget: "16.0",
  frameworks: ["SwiftUI", "WidgetKit"],
  entitlements: {
    "com.apple.security.application-groups":
      config.ios.entitlements["com.apple.security.application-groups"],
  },
});
