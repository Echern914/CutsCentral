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

/**
 * TAP TO PAY ON IPHONE — one build-time flag, three consequences that must
 * never disagree.
 *
 * 🔴 DEFAULT FALSE, AND THE DEFAULT IS THE POINT. The Apple entitlement
 * (`com.apple.developer.proximity-reader.payment.acceptance`) is granted per
 * bundle id, on request, and **a build declaring an entitlement the account has
 * not been granted FAILS TO SIGN**. Declaring it unconditionally would have
 * blocked every iOS build until Apple answered - including builds that have
 * nothing to do with payments. So off is the shipping default, and stays that
 * way until the grant lands.
 *
 * Turning it on does three things AT ONCE, from this single value:
 *   1. the entitlement goes into the generated iOS project;
 *   2. the Stripe Terminal config plugin writes the Info.plist permission
 *      strings its SDK requires;
 *   3. `extra.tapToPayNativeEnabled` tells the JS bundle it may announce the
 *      capability to the dashboard page.
 *
 * 🔴 THE THIRD IS WHY THIS IS ONE FLAG AND NOT THREE. If the shell advertised
 * Tap to Pay in a binary without the entitlement, the barber would get a button
 * that fails at the reader with a customer standing there. The announcement and
 * the entitlement are the same decision, so they are the same value.
 *
 *   TAP_TO_PAY_NATIVE_ENABLED=true eas build ...
 */
const TAP_TO_PAY_NATIVE_ENABLED = ["true", "1"].includes(
  (process.env.TAP_TO_PAY_NATIVE_ENABLED ?? "").trim().toLowerCase(),
);

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
  // 🔴 THIS STRING DOES NOT IDENTIFY A BUILD. It sat at "1.0.4" across builds 33
  // AND 34 - two different commits, one of them carrying a sign-in bug the other
  // fixed - so "1.0.4 is installed" told you nothing and nearly shipped testers
  // the exact bug they were reporting. The buildNumber (auto-incremented by EAS
  // under appVersionSource:"remote") plus `gitCommitHash` are the real identity;
  // resolve any build with `eas build:list` before trusting what's in it.
  //
  // Bump it anyway, every release, so the store listing and release notes line
  // up with something. 1.0.5 = build 35, the first release after 34 (6c9d03d).
  // 1.0.6 = the invited-barber "Join your shop" flow (#274). It needs a NATIVE
  // build, not an OTA: expo-web-browser and expo-secure-store are config
  // plugins, so the entitlement and the authentication-session APIs only exist
  // in a freshly compiled binary.
  //
  // 1.0.8 = build 39, carrying #392 (connect Stripe from inside the app via the
  // system browser). 🔴 The bump is REQUIRED, not cosmetic: 1.0.7 has already
  // gone to Apple as build 38, and a version string that was already submitted
  // cannot take another build - that is exactly how build 37 died
  // (SUBMISSION_SERVICE_IOS_OLD_APP_VERSION).
  //
  // 1.0.9 = builds 40 and 41 (41 SUBMITTED FOR REVIEW, which closed the
  // version), the first builds made LOCALLY in Xcode rather
  // than on EAS (see docs/mobile-release-xcode.md). 🔴 FROM HERE ON THE BUILD
  // NUMBER LIVES IN THIS FILE. EAS auto-incremented it under
  // appVersionSource:"remote" and its counter stopped at 39; eas.json now says
  // "local", so `buildNumber` below is the number Apple sees. Bump it by hand
  // for EVERY upload - a repeated number is rejected by App Store Connect, and
  // a repeated VERSION string after submission dies the way build 37 did.
  //   40 = archived from a tree that PREDATED #417 (no My ChairBack). An
  //        Organizer upload was ATTEMPTED on 2026-09-12 and stopped at the
  //        symbols step; no distribution certificate was ever created, so it
  //        almost certainly never reached App Store Connect. Skipped anyway -
  //        a gap costs nothing, a repeat is rejected. If a "40" ever shows up
  //        in TestFlight, it is this one: do not release it to testers.
  //   41 = the same 1.0.9 with #417 (My ChairBack) and the animated launch.
  //   42 = carrying what landed on top of 41: a customer's first AND last name
  //        (#423), "Add to my shops" (#424), the tier card with its progress bar
  //        (#426) and tier-held openings (#427). All four changed apps/mobile,
  //        so none of them reached a build-41 device - the WebView only ever
  //        carries the WEB half of a feature.
  //
  //        🔴 IT SHIPS AS 1.1.0, NOT THE 1.0.9 IT WAS CUT AS. Build 42 was
  //        committed but never uploaded, and in the meantime 1.0.9 (build 41)
  //        was SUBMITTED FOR REVIEW. A submitted version is closed to new
  //        builds - SUBMISSION_SERVICE_IOS_OLD_APP_VERSION, the wall that
  //        killed build 37 - so the string has to move before 42 can go up.
  //        The trigger is SUBMISSION, not release: the moment a version is
  //        submitted, the next build needs a new version string.
  //
  //        The build number stays 42. It must only exceed the last upload (41)
  //        and be one App Store Connect has not seen, and 42 was never uploaded.
  //
  // 1.1.0 = build 42. Minor, not patch: #423/#424/#426/#427 are features.
  //
  // 1.1.1 = build 44, uploaded 2026-09-22 (the ITMS-90683 purpose strings).
  //
  // 1.1.2 = build 46. Everything merged since 44 - booking a party (#460),
  //        domain verification (#461), targeted slots in New appointment
  //        (#474) - has never reached a phone. 45 is NOT a mistake: it is
  //        taken by the Tap to Pay 1.2.0 archive, which is built and waiting
  //        on Apple's distribution entitlement. The version string moves too,
  //        not just the number, so this cannot hit the closed-version wall if
  //        1.1.1 has been submitted (submission, not release, is the trigger).
  //
  // 1.1.3 = build 47. Join shop and the customer-side fixes (#490): the client
  //        form, Pending at shops that approve new clients, "Your shops", the
  //        doubled top gap, the sign-in name and code-button fixes. The
  //        version moves with the number, so it cannot hit the closed-version
  //        wall whatever became of 1.1.2 after it went up.
  //
  // 1.1.4 = build 48. The Announcements bell (#496) and the Instagram field on
  //        Join shop (#495). 1.1.3 is released, and #495's API refuses a new
  //        client with no last name or handle, which build 47 can only report as
  //        "Something there didn't look right" - this build asks for the handle
  //        and says what is missing.
  version: "1.1.4",
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
    // 🔴 The number Apple sees. Was ignored while EAS owned the counter
    // (appVersionSource:"remote", last EAS build = 39); it is authoritative now
    // that builds are made locally. Must exceed the previous upload, every time.
    buildNumber: "48",
    // iPhone-only for v1: the dashboard WebView isn't iPad-optimized, and
    // supporting tablet would require iPad screenshots + iPad review coverage.
    supportsTablet: false,
    // Universal links: tapping an https://getchairback.com link opens the app
    // when installed. This entry claims the DOMAIN; WHICH PATHS are claimed is
    // decided entirely by the apple-app-site-association file the web host
    // serves (/r/*, /team/join*, /auth/mobile/callback*) - so adding a path
    // means editing that route, not this line.
    associatedDomains: [`applinks:${WEB_HOST}`],
    infoPlist: {
      // Allow the WebView to load the (https) site; ATS stays on for the rest.
      NSAppTransportSecurity: { NSAllowsArbitraryLoads: false },
      // We only use Apple's OS-provided HTTPS/TLS (no custom/standard crypto of
      // our own), which is exempt from export compliance. Declaring it here means
      // App Store Connect stops asking the "App Encryption Documentation"
      // question on every upload.
      ITSAppUsesNonExemptEncryption: false,
      // The dashboard WebView has <input type="file"> fields (shop logo, gallery,
      // client CSV import). iOS offers "Take Photo" on image inputs and HARD
      // CRASHES the app if the camera usage string is missing - these are
      // required even though no native code touches the camera.
      NSCameraUsageDescription:
        "Lets you take photos for your shop page and gallery.",
      NSPhotoLibraryUsageDescription:
        "Lets you choose photos for your shop page and gallery.",
    },
    // 🔴 TAP TO PAY ON IPHONE, and ONLY when the flag is on. The entitlement is
    // NOT added by the Stripe Terminal config plugin - that one only writes
    // Info.plist permission strings - so it is declared here, and it is the
    // single line that decides whether a build can use the NFC reader at all.
    //
    // Absent by default because a build declaring an entitlement Apple has not
    // granted FAILS TO SIGN, and that must not be the cost of an unrelated
    // release. With it absent the app signs and ships exactly as before, the
    // shell announces nothing, and the checkout screen reads "Not set up on
    // this device yet" - the correct answer for a binary that genuinely cannot.
    //
    // Apple takes no cut of these payments: the entitlement is permission to
    // use the hardware, and a haircut is a real-world service expressly
    // excluded from in-app purchase.
    ...(TAP_TO_PAY_NATIVE_ENABLED
      ? {
          entitlements: {
            "com.apple.developer.proximity-reader.payment.acceptance": true,
          },
        }
      : {}),
  },
  android: {
    package: "com.getchairback.rewards",
    versionCode: 1,
    adaptiveIcon: {
      foregroundImage: "./assets/adaptive-icon.png",
      backgroundColor: "#0A0A0B",
    },
    // One verified filter per https path the app claims, mirroring the AASA
    // (apps/web/.well-known/apple-app-site-association) and the assetlinks
    // route. autoVerify only takes effect once assetlinks.json serves this
    // build's signing fingerprint - until then Android falls back to the
    // chooser, which is the correct degraded behavior, not a broken one.
    intentFilters: [
      {
        action: "VIEW",
        autoVerify: true,
        data: [
          { scheme: "https", host: WEB_HOST, pathPrefix: "/r" },
          // The invitation link, and the return leg of "Join your shop".
          { scheme: "https", host: WEB_HOST, pathPrefix: "/team/join" },
          { scheme: "https", host: WEB_HOST, pathPrefix: "/auth/mobile/callback" },
        ],
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
    // The invited-barber flow. expo-web-browser configures the native
    // authentication-session APIs (ASWebAuthenticationSession / Custom Tabs);
    // expo-secure-store adds the keychain entitlement the session token now
    // lives behind. Both are config plugins, so BOTH need a new native build -
    // they do nothing in an OTA update.
    "expo-web-browser",
    "expo-secure-store",
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
    // Stripe Terminal, for Tap to Pay on iPhone. The plugin writes the
    // Info.plist permission strings the SDK requires: location is MANDATORY for
    // Terminal (Stripe uses it for fraud and dispute evidence on card-present
    // charges), plus Bluetooth and local network.
    //
    // 🔴 UNCONDITIONAL, UNLIKE THE ENTITLEMENT - and build 43 is why. This
    // used to sit behind TAP_TO_PAY_NATIVE_ENABLED on the theory that a build
    // which cannot take a payment should not ask for location. But the SDK is
    // an ordinary dependency: it links into EVERY binary whether or not the
    // flag is set. Build 43 shipped the SDK with the flag off, so App Store
    // Connect saw Terminal's location/Bluetooth/local-network API usage with no
    // purpose strings and raised ITMS-90683 - a review-rejection risk.
    //
    // The two describe different things. These strings describe what the
    // binary CONTAINS, which is unconditional. The entitlement (above) and
    // extra.tapToPayNativeEnabled (below) describe what the binary is
    // PERMITTED and WILLING to do, and those stay behind the flag. A purpose
    // string is only shown when code actually requests the permission, which
    // happens only when the feature is armed - so a dark build carries them
    // silently.
    //
    // 🔴 A CONFIG PLUGIN DOES NOTHING IN AN OTA UPDATE. This needs a new native
    // build, like expo-web-browser and expo-secure-store above.
    [
      "@stripe/stripe-terminal-react-native",
      {
        bluetoothBackgroundMode: false,
        locationWhenInUsePermission:
          "Location is required by our card processor to accept card payments at your chair.",
      },
    ] as [string, Record<string, unknown>],
    // GoogleSignIn 9.x pulls in AppCheckCore (Swift) + GoogleUtilities /
    // RecaptchaInterop (no module maps); under Expo's static-library build that
    // breaks `pod install` unless those transitive pods get modular headers.
    "./plugins/withGoogleModularHeaders",
    // withFmtConstevalFix is GONE, on purpose. It patched fmt's source so it
    // compiled under Xcode 26, for RN 0.76. RN 0.81 (this SDK) ships fmt
    // precompiled inside the ReactNativeDependencies framework, so there is no
    // fmt source target to patch: the plugin found nothing, printed a warning
    // that looked like a problem, and a full Release build under Xcode 26.6
    // compiled every pod cleanly without it (2026-09-11, local simulator
    // build). If a `consteval` error in fmt ever comes back, the headers now
    // live at Pods/ReactNativeDependencies/Headers/fmt/ - restore the plugin
    // from git history against THAT path, not the old one.
  ],
  extra: {
    webOrigin: WEB_ORIGIN,
    apiOrigin: API_ORIGIN,
    // Surfaced to JS (expo-constants) so GoogleSignin.configure({ iosClientId })
    // reads the SAME id the iosUrlScheme plugin used - they can never drift.
    googleIosClientId: GOOGLE_IOS_CLIENT_ID,
    // 🔴 The SAME value that decided the entitlement above, handed to the JS
    // bundle so the shell can only advertise Tap to Pay in a binary that can
    // actually do it. Read through src/config.ts; never re-derived.
    tapToPayNativeEnabled: TAP_TO_PAY_NATIVE_ENABLED,
    // EAS project (created on expo.dev). Links this app to the cloud build/project.
    eas: { projectId: "6919de0f-3dba-4966-bf62-05e328f248e3" },
  },
  owner: undefined, // set automatically to your Expo account on first build/login
  experiments: { typedRoutes: true },
});
