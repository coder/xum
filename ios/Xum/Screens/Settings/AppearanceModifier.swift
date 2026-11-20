import SwiftUI

/// User-chosen appearance, persisted under `xum.appearance` and applied by the root via
/// `.xumAppearance(...)`. (Settings owns the modifier; RootView is another agent's file.)
enum Appearance: String, CaseIterable, Hashable {
    case system, light, dark

    var label: String {
        switch self {
        case .system: "System"
        case .light: "Light"
        case .dark: "Dark"
        }
    }

    var colorScheme: ColorScheme? {
        switch self {
        case .system: nil
        case .light: .light
        case .dark: .dark
        }
    }
}

struct AppearanceModifier: ViewModifier {
    let appearance: Appearance

    func body(content: Content) -> some View {
        content.preferredColorScheme(appearance.colorScheme)
    }
}

extension View {
    /// Forces the chosen light/dark scheme (nil follows the system).
    func xumAppearance(_ appearance: Appearance) -> some View {
        modifier(AppearanceModifier(appearance: appearance))
    }
}