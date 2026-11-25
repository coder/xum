import SwiftUI

/// Agent roster for the composer chip and the pickers popover.
enum AgentOption {
    static let all: [(id: String, label: String, color: Color)] = [
        ("exec", "Exec", .xAccent),
        ("plan", "Plan", .xPlan),
        ("ask", "Ask", .xAskDot),
        ("explore", "Explore", .xExploreDot),
    ]

    static let selectable: Set<String> = ["exec", "plan"]

    static func label(_ id: String) -> String { all.first { $0.id == id }?.label ?? id.capitalized }
    static func color(_ id: String) -> Color { all.first { $0.id == id }?.color ?? .xAccent }
}

/// Agent / model / thinking picker, opened from the composer chips.
struct PickersPopover: View {
    @Binding var agent: String
    @Binding var modelId: String
    @Binding var thinking: ThinkingLevel

    @Environment(\.dismiss) private var dismiss

    @Environment(AppModel.self) private var app

    /// Every level, as the New Chat picker offers; the server clamps one a model does not support.
    private var levels: [ThinkingLevel] { ThinkingLevel.allCases }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            SectionCaption(text: "Agent")
                .padding(.init(top: 12, leading: 18, bottom: 8, trailing: 18))
            HStack(spacing: 6) {
                ForEach(AgentOption.all, id: \.id) { a in
                    // The server has no user-selectable Ask or Explore agent yet (docs/07), so
                    // those pills show the design but stay disabled.
                    agentPill(a)
                        .disabled(!AgentOption.selectable.contains(a.id))
                        .opacity(AgentOption.selectable.contains(a.id) ? 1 : 0.45)
                }
            }
            .padding(.horizontal, 12)
            divider
            SectionCaption(text: "Model")
                .padding(.init(top: 10, leading: 18, bottom: 4, trailing: 18))
            ForEach(app.modelChoices, id: \.self) { m in
                modelRow(m)
            }
            divider
            HStack {
                SectionCaption(text: "Thinking")
                Spacer()
                Text(thinking.label).font(.system(size: 14, weight: .semibold))
            }
            .padding(.init(top: 10, leading: 18, bottom: 0, trailing: 18))
            Slider(value: sliderBinding, in: 0...Double(levels.count - 1), step: 1)
                .tint(.xAccentFill)
                .padding(.horizontal, 18)
                .padding(.top, 8)
            HStack {
                ForEach(levels, id: \.self) { l in
                    Text(l.chip)
                        .font(.system(size: 12, weight: l == thinking ? .semibold : .regular))
                        .foregroundStyle(l == thinking ? Color.xText : Color.xText2)
                    if l != .max { Spacer() }
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 2)
            .padding(.bottom, 14)
        }
        .frame(width: 330)
        .glassRect(32)
    }

    private var divider: some View {
        Rectangle().fill(Color.xSep).frame(height: 0.5)
            .padding(.init(top: 14, leading: 0, bottom: 4, trailing: 0))
    }

    private func agentPill(_ a: (id: String, label: String, color: Color)) -> some View {
        let selected = agent == a.id
        return Button {
            agent = a.id
            dismiss()
        } label: {
            HStack(spacing: 6) {
                StatusDot(color: a.color, size: 8)
                Text(a.label)
            }
            .font(.system(size: 14, weight: .medium))
            .foregroundStyle(selected ? a.color : Color.xText)
            .frame(maxWidth: .infinity)
            .frame(height: 40)
            .background(selected ? Color.xAccentSoft : Color.xFill2, in: Capsule())
            .overlay(Capsule().strokeBorder(selected ? a.color : .clear, lineWidth: 1.5))
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
    }

    private func modelRow(_ m: String) -> some View {
        let selected = modelId == m
        return Button {
            modelId = m
            dismiss()
        } label: {
            HStack(spacing: 10) {
                Image(systemName: "checkmark")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(Color.xAccent)
                    .opacity(selected ? 1 : 0)
                    .frame(width: 18)
                Text(ModelName.display(m)).fontWeight(selected ? .semibold : .regular)
                Spacer(minLength: 8)
                Text(ModelName.provider(m)).font(.xMono(12)).foregroundStyle(Color.xText3)
            }
            .font(.system(size: 16))
            .foregroundStyle(Color.xText)
            .frame(height: 44)
            .padding(.horizontal, 18)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private var sliderBinding: Binding<Double> {
        Binding(
            get: { Double(levels.firstIndex(of: thinking) ?? 2) },
            set: { thinking = levels[Int($0)] }
        )
    }
}