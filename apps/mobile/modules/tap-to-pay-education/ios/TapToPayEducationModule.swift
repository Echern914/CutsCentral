import ExpoModulesCore
import ProximityReader
import UIKit

/**
 * Apple's "How to Tap" merchant education, which is REQUIRED.
 *
 * 🔴 NOT OPTIONAL, AND NOT SOMETHING WE MAY DESIGN OURSELVES. Stripe's Tap to
 * Pay documentation states it plainly: "Apple requires you to present a 'How to
 * Tap' instructional overlay when enabling Tap to Pay on iPhone. You must
 * integrate this before submitting your app for review." An app that ships
 * without it fails App Review, and a home-made overlay does not satisfy the
 * requirement on iOS 18+ - Apple's own content is localized for the merchant's
 * region and kept current by Apple.
 *
 * The Stripe Terminal React Native SDK does NOT expose this API, which is why
 * this module exists. `ProximityReader` is a built-in system framework already
 * linked by the Terminal SDK, so there is no new dependency here.
 *
 * TWO STEPS, in Apple's documented order:
 *   1. `content(for: .payment(.howToTap))` fetches the educational content.
 *   2. `presentContent(_:from:)` displays it.
 *
 * 🔴 THE VIEW CONTROLLER MUST BE THE TOPMOST PRESENTED ONE or the call fails.
 * This app is a WebView inside a navigation stack that also presents sheets, so
 * the root is frequently NOT the top; `topViewController()` walks the chain.
 *
 * 🔴 UNVERIFIED. Nothing in this file has run: it needs an entitlement this
 * account does not have, and a physical iPhone. It is written to match Apple's
 * and Stripe's documented API exactly, and it is unproven until the real-device
 * script in docs/service-checkout.md has been ticked.
 */
public class TapToPayEducationModule: Module {
  public func definition() -> ModuleDefinition {
    Name("TapToPayEducation")

    /**
     * Whether Apple's native overlay can be shown on THIS device.
     *
     * False on iOS 17 and earlier, where the API does not exist and the caller
     * must show its own instructions instead. Never throws: "can I?" must be
     * answerable without a failure path.
     */
    Function("isNativeEducationAvailable") { () -> Bool in
      if #available(iOS 18.0, *) {
        return true
      }
      return false
    }

    /**
     * Present Apple's overlay.
     *
     * Rejects rather than silently doing nothing, so the caller can fall back
     * to its own screen and - crucially - can decline to mark the education as
     * shown. Recording education that never appeared would be worse than not
     * recording it at all: it is the record Apple's requirement rests on.
     */
    AsyncFunction("presentHowToTap") { (promise: Promise) in
      guard #available(iOS 18.0, *) else {
        promise.reject(
          "ERR_UNAVAILABLE",
          "ProximityReaderDiscovery requires iOS 18 or later"
        )
        return
      }

      DispatchQueue.main.async {
        guard let top = Self.topViewController() else {
          promise.reject("ERR_NO_VIEW_CONTROLLER", "No view controller to present from")
          return
        }
        Task { @MainActor in
          do {
            let discovery = ProximityReaderDiscovery()
            let content = try await discovery.content(for: .payment(.howToTap))
            // 🔴 `try await`, AND STRIPE'S PUBLISHED SNIPPET HAS NEITHER. Their
            // documentation shows `discovery.presentContent(content, from: vc)`
            // bare; the real API is `async throws`, and a build written from
            // that snippet does not compile:
            //
            //   error: call can throw but is not marked with 'try'
            //   error: expression is 'async' but is not marked with 'await'
            //
            // Found by an actual EAS build. No amount of TypeScript checking
            // would have caught it, because none of this is TypeScript.
            //
            // It being async is also good news: awaiting it means the overlay
            // was shown AND finished, so the caller gets a real completion
            // rather than "we asked for it to appear".
            try await discovery.presentContent(content, from: top)
            promise.resolve(true)
          } catch {
            promise.reject("ERR_PRESENT_FAILED", error.localizedDescription)
          }
        }
      }
    }
  }

  /**
   * The topmost presented view controller.
   *
   * Apple's API fails if handed anything else, and in this app the root is
   * routinely covered: the dashboard WebView sits in a stack, and the checkout
   * screen itself can be over a presented sheet.
   */
  private static func topViewController() -> UIViewController? {
    let scenes = UIApplication.shared.connectedScenes
      .compactMap { $0 as? UIWindowScene }
      .filter { $0.activationState == .foregroundActive }
    let window =
      scenes.flatMap { $0.windows }.first(where: { $0.isKeyWindow })
      ?? scenes.flatMap { $0.windows }.first
    guard var top = window?.rootViewController else { return nil }
    while let presented = top.presentedViewController {
      top = presented
    }
    return top
  }
}
