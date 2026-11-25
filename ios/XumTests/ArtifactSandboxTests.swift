import Foundation
import Testing
import WebKit
@testable import Xum

@MainActor
struct ArtifactSandboxTests {
    private final class Loaded: NSObject, WKNavigationDelegate {
        var continuation: CheckedContinuation<Void, Never>?
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            continuation?.resume()
            continuation = nil
        }
    }

    /// Loads `html` the way the Artifacts tab does and returns what `probe` evaluates to.
    private func evaluate(_ html: String, _ probe: String) async throws -> String {
        let delegate = Loaded()
        var view: WKWebView?
        await withCheckedContinuation { c in
            delegate.continuation = c
            view = SandboxedWebView.load(html, delegate: delegate)
        }
        let result = try await view!.evaluateJavaScript(probe)
        return "\(result ?? "nil")"
    }

    private let probe = """
    (() => {
      const own = typeof RTCPeerConnection + "," + typeof webkitRTCPeerConnection + "," + typeof RTCDataChannel;
      const f = document.createElement("iframe");
      document.body.appendChild(f);
      let child;
      try { child = typeof f.contentWindow.RTCPeerConnection; } catch (e) { child = "blocked"; }
      return own + "|" + child + "|" + (document.querySelector("#early") ? document.querySelector("#early").textContent : "");
    })()
    """

    @Test func artifactPagesHaveNoWebRTC() async throws {
        let page = "<!doctype html><html><body><p id=early></p><script>document.getElementById('early').textContent = typeof RTCPeerConnection</script></body></html>"
        let parts = try await evaluate(page, probe).split(separator: "|").map(String.init)
        #expect(parts[0] == "undefined,undefined,undefined")
        // A script in the page itself also ran after the globals were removed.
        #expect(parts[2] == "undefined")
        // A frame the page makes must not hand it fresh RTC constructors.
        #expect(parts[1] != "function")
    }

    @Test func policyKeepsTheDoctypeFirst() {
        let out = SandboxedWebView.withPolicy("  <!DOCTYPE html><p>x")
        #expect(out.hasPrefix("<!DOCTYPE html><meta"))
        #expect(SandboxedWebView.withPolicy("<svg/>").hasPrefix("<meta"))
    }
}
