import ExpoModulesCore
import PassKit
import UIKit

/**
 * Add an appointment pass to Apple Wallet from INSIDE the app.
 *
 * WHY THIS EXISTS AT ALL. On the web, "Add to Apple Wallet" is a plain
 * same-tab navigation to a .pkpass and Safari presents the add sheet itself.
 * That does not work in a WKWebView: the navigation either downloads nothing
 * or dead-ends, which is exactly why components/AddToWallet.tsx refuses to
 * render inside the app. The supported path in an app is PassKit's own
 * `PKAddPassesViewController`, and nothing in React Native or Expo exposes it -
 * hence this module.
 *
 * 🔴 NARROW ON PURPOSE. It takes a URL, fetches bytes, and presents Apple's
 * sheet. It does not choose the URL (the shell builds that from a manage token -
 * see src/walletBridge.ts), it does not authenticate, and it keeps nothing. A
 * bridge reachable from a web page must be able to do as little as possible.
 *
 * 🔴 NO ENTITLEMENT, UNLIKE TAP TO PAY. PassKit's add-pass sheet needs no
 * special capability and no Apple approval, so this compiles and runs on any
 * build. What is NOT provable without Apple certificates is the pass itself:
 * the server cannot SIGN one until the WALLET_APPT_* ceremony is done, so
 * `presentPass` has never been handed real bytes. The failure paths below are
 * written for that day.
 */
public class WalletPassModule: Module {
  /**
   * The delegate must outlive the presentation. PKAddPassesViewController holds
   * its delegate WEAKLY, so a delegate created inline in the AsyncFunction is
   * deallocated the moment that closure returns - the sheet then never
   * dismisses and the promise never settles. Holding it here is the fix.
   */
  private var presenter: PassPresenter?

  public func definition() -> ModuleDefinition {
    Name("WalletPass")

    /**
     * Can this device hold passes at all?
     *
     * False on a device where Wallet is unavailable or restricted (some MDM
     * profiles, some regions). Never throws: "can I?" must be answerable
     * without a failure path, so the caller can simply not draw the button.
     */
    Function("canAddPasses") { () -> Bool in
      PKAddPassesViewController.canAddPasses()
    }

    /**
     * Fetch the signed .pkpass at `url` and present Apple's add sheet.
     *
     * Resolves TRUE only when the pass actually reached Wallet, and FALSE when
     * the customer dismissed the sheet without adding it. Those are different
     * outcomes and the caller is entitled to tell them apart - "added" drives a
     * confirmation, "dismissed" must not.
     *
     * Rejects on anything that means we could not offer the pass at all. The
     * distinct codes exist because these have genuinely different causes: a 404
     * is the server declining to mint (unconfigured, or not BOOKED), while
     * ERR_INVALID_PASS means bytes arrived and PassKit refused them - which on
     * this product almost always means the signing certificate does not match
     * the pass type id.
     */
    AsyncFunction("presentPass") { (url: URL, promise: Promise) in
      guard PKAddPassesViewController.canAddPasses() else {
        promise.reject("ERR_UNAVAILABLE", "This device cannot add passes to Wallet")
        return
      }

      let task = URLSession.shared.dataTask(with: url) { data, response, error in
        if let error {
          promise.reject("ERR_DOWNLOAD_FAILED", error.localizedDescription)
          return
        }
        if let http = response as? HTTPURLResponse, !(200...299).contains(http.statusCode) {
          promise.reject(
            "ERR_DOWNLOAD_FAILED",
            "The pass could not be downloaded (HTTP \(http.statusCode))"
          )
          return
        }
        guard let data, !data.isEmpty else {
          promise.reject("ERR_DOWNLOAD_FAILED", "The pass was empty")
          return
        }

        let pass: PKPass
        do {
          pass = try PKPass(data: data)
        } catch {
          // 🔴 The likeliest real cause is a SIGNING mismatch, not corruption:
          // a pass whose passTypeIdentifier does not match the certificate it
          // was signed with parses as invalid here and nowhere earlier.
          promise.reject("ERR_INVALID_PASS", error.localizedDescription)
          return
        }

        DispatchQueue.main.async {
          guard let top = Self.topViewController() else {
            promise.reject("ERR_NO_VIEW_CONTROLLER", "No view controller to present from")
            return
          }
          guard let vc = PKAddPassesViewController(pass: pass) else {
            promise.reject("ERR_PRESENT_FAILED", "Wallet refused to present this pass")
            return
          }
          let presenter = PassPresenter { [weak self] in
            // Whether Wallet kept it. `containsPass` is the only honest answer:
            // the delegate fires the same way for "Add" and for "Cancel".
            let added = PKPassLibrary().containsPass(pass)
            vc.dismiss(animated: true) {
              promise.resolve(added)
              self?.presenter = nil
            }
          }
          self.presenter = presenter
          vc.delegate = presenter
          top.present(vc, animated: true)
        }
      }
      task.resume()
    }
  }

  /**
   * The topmost presented view controller.
   *
   * This app is a WebView inside a navigation stack that also presents modals
   * (the storefront and the manage page are both full-screen sheets), so the
   * root is routinely covered. Presenting from anything but the top silently
   * does nothing.
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

/** Turns the one delegate callback into a closure the module can hold. */
private final class PassPresenter: NSObject, PKAddPassesViewControllerDelegate {
  private let onFinish: () -> Void

  init(onFinish: @escaping () -> Void) {
    self.onFinish = onFinish
  }

  func addPassesViewControllerDidFinish(_ controller: PKAddPassesViewController) {
    onFinish()
  }
}
