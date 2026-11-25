import ObjectiveC
import SwiftUI
import UIKit

/// On the iPhone Duo (iOS 27.1+) the system puts the status bar and toolbar items in a vertical bar on the
/// trailing edge of both displays, which costs the app an 84 pt column. Safari opts out, so its status sits
/// at the top beside its toolbar, and Xum does the same with `UIVerticalBarBehaviorDisabled`.
/// SwiftUI has no modifier for it and the App lifecycle owns the root hosting controller, whose class
/// already overrides `preferredVerticalBarBehavior`, so the getter is replaced on that controller's own
/// (private, generic) class only. Presentations inherit the root's choice.
struct HorizontalStatusBar: UIViewRepresentable {
    func makeUIView(context: Context) -> ProbeView { ProbeView() }
    func updateUIView(_ uiView: ProbeView, context: Context) {}

    final class ProbeView: UIView {
        override func didMoveToWindow() {
            super.didMoveToWindow()
            guard #available(iOS 27.1, *), let root = window?.rootViewController else { return }
            HorizontalStatusBar.disableVerticalBar(on: root)
        }
    }

    @available(iOS 27.1, *)
    private static func disableVerticalBar(on controller: UIViewController) {
        let selector = #selector(getter: UIViewController.preferredVerticalBarBehavior)
        guard let method = class_getInstanceMethod(UIViewController.self, selector) else { return }
        let disabled: @convention(block) (UIViewController) -> Int = { _ in
            UIVerticalBarBehavior.disabled.rawValue
        }
        class_replaceMethod(
            type(of: controller), selector, imp_implementationWithBlock(disabled), method_getTypeEncoding(method))
        controller.setNeedsUpdateOfVerticalBarConfiguration()
    }
}
