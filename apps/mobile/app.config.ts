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

// The Google iOS OAuth client id (Google Cloud Console > Credentials > iOS client,
// bundle com.getchairback.rewards). ONE source of truth for three things that must
// agree: the backend's GOOGLE_OAUTH_IOS_CLIENT_ID env, GoogleSignin.configure({
// iosClientId }), and the reversed URL scheme below. We configure Google with
// iosClientId ONLY (no webClientId), so the returned idToken's `aud` equals this
// id, which is exactly what the backend verifies.
const GOOGLE_IOS_CLIENT_ID =
  process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID ??
  "435440347259-d8vfpb97rv53vuvu7nh46nc4s0fs1d68.apps.googleusercontent.com";
// The reversed-client-id URL scheme iOS registers so Google can redirect back:
// the client id with its two dot-halves swapped.
const GOOGLE_IOS_URL_SCHEME = `com.googleusercontent.apps.${GOOGLE_IOS_CLIENT_ID.replace(
  ".apps.googleusercontent.com",
  "",
)}`;

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: "ChairBack Rewards",
  // Must match the slug of the EAS project (projectId below), created on expo.dev.
  slug: "chairback",
  scheme: "chairback", // custom-scheme deep links: chairback://r/<token>
  // Bumped so the launch-hang-fixed build is visually distinguishable from the
  // earlier broken one in TestFlight (the iOS buildNumber is auto-incremented by
  // EAS remotely, so this user-facing version is the reliable marker).
  version: "1.0.3",
  orientation: "portrait",
  userInterfaceStyle: "automatic",
  newArchEnabled: true,
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
    // Native Sign in with Apple. Bare string; the plugin auto-adds the
    // com.apple.developer.applesignin entitlement (["Default"]) to the generated
    // iOS project - no hand-edited .entitlements file.
    "expo-apple-authentication",
    // Native Google Sign-In. iosUrlScheme is the REVERSED iOS OAuth client id;
    // the plugin injects it into CFBundleURLTypes at prebuild so Google can
    // redirect back into the app.
    [
      "@react-native-google-signin/google-signin",
      { iosUrlScheme: GOOGLE_IOS_URL_SCHEME },
    ],
    // GoogleSignIn 9.x pulls in AppCheckCore (Swift) + GoogleUtilities /
    // RecaptchaInterop (no module maps); under Expo's static-library build that
    // breaks `pod install` unless those transitive pods get modular headers.
    "./plugins/withGoogleModularHeaders",
    // Keep LAST: makes fmt 11.0.2 (bundled by RN 0.81) compile under Xcode 26's
    // Clang, which Apple now requires for App Store builds. See the plugin.
    "./plugins/withFmtConstevalFix",
  ],
  extra: {
    webOrigin: WEB_ORIGIN,
    apiOrigin: API_ORIGIN,
    // Surfaced to JS (expo-constants) so GoogleSignin.configure({ iosClientId })
    // reads the SAME id the iosUrlScheme plugin used - they can never drift.
    googleIosClientId: GOOGLE_IOS_CLIENT_ID,
    // EAS project (created on expo.dev). Links this app to the cloud build/project.
    eas: { projectId: "6919de0f-3dba-4966-bf62-05e328f248e3" },
  },
  owner: undefined, // set automatically to your Expo account on first build/login
  experiments: { typedRoutes: true },
});
