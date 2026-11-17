import SwiftUI
import UIKit

/// Colour tokens from the design package (docs/02-design-system.md §2). Views read these,
/// never raw hex values.
extension Color {
    static let xBg = dyn(light: 0xFFFFFF, dark: (9, 11, 11))
    static let xBg2 = dyn(light: 0xF4F4F5, dark: (9, 11, 11))
    static let xCell = dyn(light: 0xFFFFFF, dark: 0x18181B)
    static let xRaised = dyn(light: 0xFFFFFF, dark: 0x26262B)
    static let xFill = dynA(light: (120, 120, 128, 0.14), dark: (120, 120, 128, 0.26))
    static let xFill2 = dynA(light: (120, 120, 128, 0.08), dark: (120, 120, 128, 0.16))
    static let xText = dyn(light: (9, 11, 11), dark: 0xFAFAFA)
    static let xText2 = dyn(light: 0x52525B, dark: 0xA1A1AA)
    static let xText3 = dyn(light: 0x6B6B74, dark: 0x8B8B94)
    static let xSep = dynA(light: (9, 11, 11, 0.10), dark: (255, 255, 255, 0.10))
    static let xAccent = dyn(light: (117, 17, 226), dark: (188, 124, 255))
    static let xAccentFill = dyn(light: (117, 17, 226), dark: (151, 71, 255))
    static let xAccentSoft = dynA(light: (117, 17, 226, 0.09), dark: (188, 124, 255, 0.14))
    static let xPlan = dyn(light: 0x1F66AD, dark: 0x73A9E3)
    static let xPlanSoft = dynA(light: (31, 102, 173, 0.07), dark: (115, 169, 227, 0.08))
    static let xPlanLine = dynA(light: (31, 102, 173, 0.22), dark: (115, 169, 227, 0.24))
    static let xThink = dyn(light: 0x0E6AD8, dark: 0x64A3F8)
    static let xOk = dyn(light: 0x15803D, dark: 0x4ADE80)
    static let xWarn = dyn(light: 0xB45309, dark: 0xFFB366)
    static let xBad = dyn(light: 0xDC2626, dark: 0xF87171)
    static let xCode = dyn(light: 0x8D5A2A, dark: 0xD19A66)
    static let xCodeBg = dyn(light: 0xF4F4F5, dark: 0x141417)
    static let xUser = dyn(light: 0xEDEDED, dark: 0x1C1C20)
    static let xDiffAdd = dynA(light: (21, 128, 61, 0.10), dark: (74, 222, 128, 0.12))
    static let xDiffDel = dynA(light: (220, 38, 38, 0.09), dark: (248, 113, 113, 0.12))
    static let xDim = dynA(light: (9, 11, 11, 0.20), dark: (0, 0, 0, 0.50))
    static let xCam = dyn(light: 0x2F2D33, dark: 0x141416)
    static let xSsh = Color(uiColor: UIColor(hex: 0x3B82F6))
    static let xAskDot = Color(uiColor: UIColor(hex: 0x6E5CFF))
    static let xExploreDot = Color(uiColor: UIColor(hex: 0x0E9AA7))

    private static func dyn(light: Int, dark: Int) -> Color {
        Color(uiColor: UIColor { $0.userInterfaceStyle == .dark ? UIColor(hex: dark) : UIColor(hex: light) })
    }
    private static func dyn(light: (Int, Int, Int), dark: Int) -> Color {
        Color(uiColor: UIColor { $0.userInterfaceStyle == .dark ? UIColor(hex: dark) : UIColor(rgb: light) })
    }
    private static func dyn(light: Int, dark: (Int, Int, Int)) -> Color {
        Color(uiColor: UIColor { $0.userInterfaceStyle == .dark ? UIColor(rgb: dark) : UIColor(hex: light) })
    }
    private static func dyn(light: (Int, Int, Int), dark: (Int, Int, Int)) -> Color {
        Color(uiColor: UIColor { $0.userInterfaceStyle == .dark ? UIColor(rgb: dark) : UIColor(rgb: light) })
    }
    private static func dynA(light: (Int, Int, Int, Double), dark: (Int, Int, Int, Double)) -> Color {
        Color(uiColor: UIColor { $0.userInterfaceStyle == .dark ? UIColor(rgba: dark) : UIColor(rgba: light) })
    }
}

extension UIColor {
    convenience init(hex: Int) {
        self.init(red: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255, blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
    }
    convenience init(rgb: (Int, Int, Int)) {
        self.init(red: CGFloat(rgb.0) / 255, green: CGFloat(rgb.1) / 255, blue: CGFloat(rgb.2) / 255, alpha: 1)
    }
    convenience init(rgba: (Int, Int, Int, Double)) {
        self.init(red: CGFloat(rgba.0) / 255, green: CGFloat(rgba.1) / 255, blue: CGFloat(rgba.2) / 255, alpha: rgba.3)
    }
}

/// Type roles (docs/02 §4). The brand fonts (Lay Grotesk, FT System Mono) are licensed, so the
/// app uses the documented fallback: SF Pro for titles/body and SF Mono for captions and identifiers.
extension Font {
    static let xLargeTitle = Font.system(size: 34, weight: .semibold).leading(.tight)
    static let xTitle = Font.system(size: 28, weight: .semibold)
    static let xCardTitle = Font.system(size: 21, weight: .semibold)
    static let xBody = Font.system(size: 17)
    static let xCaption = Font.system(size: 12, design: .monospaced)
    static func xMono(_ size: CGFloat, weight: Font.Weight = .regular) -> Font {
        .system(size: size, weight: weight, design: .monospaced)
    }
}

/// Mono uppercase section caption (`.cap` in the mockups).
struct SectionCaption: View {
    let text: String
    var body: some View {
        Text(text.uppercased())
            .font(.xCaption)
            .kerning(0.4)
            .foregroundStyle(Color.xText3)
    }
}

/// `xum▌` wordmark: lowercase mono with a solid block cursor.
struct Wordmark: View {
    var size: CGFloat = 20
    var body: some View {
        HStack(spacing: size * 0.08) {
            Text("xum").font(.system(size: size, weight: .semibold, design: .monospaced))
                .foregroundStyle(Color.xText)
            Rectangle().fill(Color.xAccentFill).frame(width: size * 0.5, height: size * 0.95)
        }
        .accessibilityLabel("Xum")
    }
}

struct StatusDot: View {
    let color: Color
    var size: CGFloat = 8
    var body: some View { Circle().fill(color).frame(width: size, height: size) }
}

/// Neutral chip (height 32, radius 16).
struct Chip<Label: View>: View {
    var selected = false
    @ViewBuilder var label: Label
    var body: some View {
        label
            .font(.system(size: 15, weight: .medium))
            .foregroundStyle(Color.xText)
            .padding(.horizontal, 12)
            .frame(height: 32)
            .background(selected ? Color.xAccentSoft : Color.xFill2, in: Capsule())
    }
}

extension View {
    /// Liquid Glass for floating chrome; content stays opaque.
    func glassCapsule() -> some View { glassEffect(.regular.interactive(), in: .capsule) }
    func glassCircle() -> some View { glassEffect(.regular.interactive(), in: .circle) }
    func glassRect(_ radius: CGFloat) -> some View { glassEffect(.regular, in: .rect(cornerRadius: radius)) }
}
