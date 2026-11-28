import UIKit
import WebKit
import Capacitor

// Capacitor's web view with two NovaX changes:
//  - the iPhone's edge swipe goes back one step in the portal's history, like the Android back button;
//  - a page load that is merely cancelled (the portal sending a signed-out visitor to the sign-in page,
//    a link opened outside the app) no longer shows the "You're offline" screen. Capacitor treats every
//    failed navigation as an error and loads errorPath; only real failures (no internet, DNS, timeouts)
//    should do that.
class NovaxViewController: CAPBridgeViewController {
    private var navProxy: NovaxNavigationProxy?

    override func capacitorDidLoad() {
        super.capacitorDidLoad()
        webView?.allowsBackForwardNavigationGestures = true
        bridge?.registerPluginInstance(NovaxPrintPlugin())
        if let webView = webView, let inner = webView.navigationDelegate {
            let proxy = NovaxNavigationProxy(inner: inner)
            navProxy = proxy   // navigationDelegate is weak
            webView.navigationDelegate = proxy
        }
    }
}

// Passes every navigation callback to Capacitor's own handler, except failures that are only cancellations.
final class NovaxNavigationProxy: NSObject, WKNavigationDelegate {
    private weak var inner: WKNavigationDelegate?

    init(inner: WKNavigationDelegate) {
        self.inner = inner
        super.init()
    }

    override func responds(to aSelector: Selector!) -> Bool {
        return super.responds(to: aSelector) || (inner?.responds(to: aSelector) ?? false)
    }

    override func forwardingTarget(for aSelector: Selector!) -> Any? {
        return inner
    }

    private static func isCancellation(_ error: Error) -> Bool {
        let e = error as NSError
        if e.domain == NSURLErrorDomain && e.code == NSURLErrorCancelled { return true }
        // WebKitErrorFrameLoadInterruptedByPolicyChange: a link handed to another app or turned into a download.
        if e.domain == "WebKitErrorDomain" && e.code == 102 { return true }
        return false
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        if NovaxNavigationProxy.isCancellation(error) { return }
        inner?.webView?(webView, didFailProvisionalNavigation: navigation, withError: error)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        if NovaxNavigationProxy.isCancellation(error) { return }
        inner?.webView?(webView, didFail: navigation, withError: error)
    }
}

// window.print() for the portal. An app's web view has no print window, so the portal calls
// NovaxPrint.print() instead (see the native bridge at the end of client-app.js). This opens the
// iPhone's print sheet on the current page, with its print CSS, and resolves when the sheet closes,
// which is when the portal fires afterprint and tidies up the print area.
@objc(NovaxPrintPlugin)
public class NovaxPrintPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NovaxPrintPlugin"
    public let jsName = "NovaxPrint"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "print", returnType: CAPPluginReturnPromise)
    ]

    @objc func print(_ call: CAPPluginCall) {
        let name = call.getString("name") ?? "NovaX"
        DispatchQueue.main.async {
            guard let webView = self.bridge?.webView else {
                call.reject("Printing is not available right now.")
                return
            }
            let info = UIPrintInfo(dictionary: nil)
            info.outputType = .general
            info.jobName = name
            let controller = UIPrintInteractionController.shared
            controller.printInfo = info
            controller.printFormatter = webView.viewPrintFormatter()
            let done: UIPrintInteractionController.CompletionHandler = { _, completed, error in
                if let error = error {
                    call.reject(error.localizedDescription)
                } else {
                    call.resolve(["closed": true, "printed": completed])
                }
            }
            if UIDevice.current.userInterfaceIdiom == .pad {
                let rect = CGRect(x: webView.bounds.midX, y: webView.bounds.midY, width: 1, height: 1)
                controller.present(from: rect, in: webView, animated: true, completionHandler: done)
            } else {
                controller.present(animated: true, completionHandler: done)
            }
        }
    }
}
