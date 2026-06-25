import type { ExpoConfig, ConfigContext } from "expo/config";

/**
 * CutsCentral / ChairBack customer iOS app.
 *
 * This is a THIN native shell around the existing rewards web page
 * (getchairback.com/r/[magicToken]) - it is NOT a re-implemented UI. A WebView
 * renders the same page customers see in a browser/PWA; the native layer adds
 * only what the web can't do on iOS: App Store presence, deep links from the SMS
 * magic link, and native APNs push (alongside the web's VAPID push).
 *
 * The web origin is configurable so a dev build can point at localhost while a
 * store build points at production.
 */

// The site the WebView loads + the universal-link host. Override for local dev
// with EXPO_PUBLIC_WEB_ORIGIN (e.g. your machine's LAN IP) when testing on a
// physical device against a local server.
const WEB_ORIGIN = process.env.EXPO_PUBLIC_WEB_ORIGIN ?? "https://getchairback.com";
const WEB_HOST = WEB_ORIGIN.replace(/^https?:\/\//, "");
// The API origin the native app calls directly (no browser CSP in a native app).
const API_ORIGIN = process.env.EXPO_PUBLIC_API_ORIGIN ?? "https://api.getchairback.com";

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: "ChairBack Rewards",
  // Must match the slug of the EAS project (projectId below), created on expo.dev.
  slug: "chairback",
  scheme: "chairback", // custom-scheme deep links: chairback://r/<token>
  // Bumped so the launch-hang-fixed build is visually distinguishable from the
  // earlier broken one in TestFlight (the iOS buildNumber is auto-incremented by
  // EAS remotely, so this user-facing version is the reliable marker).
  version: "1.0.1",
  orientation: "portrait",
  userInterfaceStyle: "automatic",
  // New Architecture OFF: this is a WebView-wrapper app that uses NO Fabric/
  // TurboModule features, and the New Arch is what drags in the folly/{fmt}
  // native compile path that breaks on Xcode 26 (the fmt consteval error). Off =
  // that whole failure class is gone, with zero feature cost for this app. The
  // withFmtConstevalFix plugin remains as belt-and-suspenders.
  newArchEnabled: false,
  icon: "./assets/icon.png",
  splash: {
    image: "./assets/splash.png",
    resizeMode: "contain",
    backgroundColor: "#0A0A0B",
  },
  ios: {
    // Reverse-DNS bundle id, aligned with the getchairback.com domain + brand.
    bundleIdentifier: "com.getchairback.rewards",
    buildNumber: "1",
    supportsTablet: true,
    // Universal links: tapping https://getchairback.com/r/<token> opens the app
    // when installed (requires the matching apple-app-site-association file on
    // the web host - see the runbook).
    associatedDomains: [`applinks:${WEB_HOST}`],
    infoPlist: {
      // Allow the WebView to load the (https) site; ATS stays on for the rest.
      NSAppTransportSecurity: { NSAllowsArbitraryLoads: false },
      // We only use Apple's OS-provided HTTPS/TLS (no custom/standard crypto of
      // our own), which is exempt from export compliance. Declaring it here means
      // App Store Connect stops asking the "App Encryption Documentation"
      // question on every upload.
      ITSAppUsesNonExemptEncryption: false,
    },
  },
  android: {
    package: "com.getchairback.rewards",
    versionCode: 1,
    adaptiveIcon: {
      foregroundImage: "./assets/adaptive-icon.png",
      backgroundColor: "#0A0A0B",
    },
    intentFilters: [
      {
        action: "VIEW",
        autoVerify: true,
        data: [{ scheme: "https", host: WEB_HOST, pathPrefix: "/r" }],
        category: ["BROWSABLE", "DEFAULT"],
      },
    ],
  },
  plugins: [
    "expo-router",
    [
      "expo-notifications",
      {
        // App icon used for the notification badge; replace with branded assets.
        icon: "./assets/notification-icon.png",
        color: "#0A0A0B",
      },
    ],
    // SDK 54 / RN 0.81 STILL ships the fmt that breaks on Xcode 26 (the upstream
    // RN fix is 0.82.1+). Re-added: compile fmt/RCT-Folly as C++17 (no consteval)
    // + patch the header. See plugins/withFmtConstevalFix.js.
    "./plugins/withFmtConstevalFix",
  ],
  extra: {
    webOrigin: WEB_ORIGIN,
    apiOrigin: API_ORIGIN,
    // EAS project (created on expo.dev). Links this app to the cloud build/project.
    eas: { projectId: "6919de0f-3dba-4966-bf62-05e328f248e3" },
  },
  owner: undefined, // set automatically to your Expo account on first build/login
  experiments: { typedRoutes: true },
});
