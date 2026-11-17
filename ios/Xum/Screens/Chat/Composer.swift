import SwiftUI

/// Glass composer above the tab bar, shared by Chat and NewChat.
struct Composer: View {
    @Binding var text: String
    @Binding var agent: String
    @Binding var modelId: String
    @Binding var thinking: ThinkingLevel
    var placeholder: String
    var isStreaming: Bool
    var contextFraction: Double?
    var onSend: () -> Void
    var onStop: () -> Void

    @FocusState private var focused: Bool
    @State private var showPicker = false

    private var canSend: Bool {
        !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var body: some View {
        VStack(spacing: 0) {
            TextField(placeholder, text: $text, axis: .vertical)
                .font(.system(size: 16))
                .lineLimit(1...6)
                .padding(.horizontal, 8)
                .focused($focused)
            HStack(spacing: 6) {
                ScrollView(.horizontal, showsIndicators: false) { chips }
                    .scrollClipDisabled()
                    .layoutPriority(-1)
                Spacer(minLength: 0)
                attachButton
                sendStopButton
            }
            .padding(.top, 12)
        }
        .padding(.init(top: 14, leading: 10, bottom: 10, trailing: 10))
        .glassRect(28)
        .popover(isPresented: $showPicker, arrowEdge: .bottom) {
            PickersPopover(agent: $agent, modelId: $modelId, thinking: $thinking)
                .presentationCompactAdaptation(.popover)
        }
    }

    private var chips: some View {
        HStack(spacing: 6) {
            chip {
                HStack(spacing: 6) {
                    StatusDot(color: AgentOption.color(agent), size: 8)
                    Text(AgentOption.label(agent))
                }
                .foregroundStyle(AgentOption.color(agent))
            }
            chip {
                HStack(spacing: 4) {
                    Text(ModelName.display(modelId))
                    Image(systemName: "chevron.down")
                        .font(.system(size: 9, weight: .semibold))
                        .rotationEffect(.degrees(showPicker ? 180 : 0))
                }
            }
            chip { Text(thinking.chip) }
            contextChip
        }
    }

    private func chip<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        Button { showPicker = true } label: {
            content()
                .font(.system(size: 15, weight: .medium))
                .lineLimit(1)
                .fixedSize()
                .padding(.horizontal, 12)
                .frame(height: 32)
                .background(Color.xFill2, in: Capsule())
                .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .foregroundStyle(Color.xText)
    }

    private var contextChip: some View {
        HStack(spacing: 6) {
            ContextRing(fraction: contextFraction)
        }
        .frame(width: 32, height: 32)
        .background(Color.xFill2, in: Circle())
        .accessibilityLabel(contextFraction.map { "Context \(Int(($0 * 100).rounded()))% used" } ?? "Context usage")
    }

    private var attachButton: some View {
        Button { } label: {
            Image(systemName: "paperclip")
                .font(.system(size: 17))
                .frame(width: 34, height: 34)
                .contentShape(Rectangle())
        }
        .foregroundStyle(Color.xText2)
        .disabled(true)
        .accessibilityLabel("Attach")
    }

    /// Send; while streaming with an empty field, Stop replaces it.
    @ViewBuilder private var sendStopButton: some View {
        if isStreaming, !canSend {
            Button(action: onStop) {
                RoundedRectangle(cornerRadius: 2.5)
                    .fill(Color.xBg)
                    .frame(width: 12, height: 12)
            }
            .frame(width: 36, height: 36)
            .background(Color.xText, in: Circle())
            .accessibilityLabel("Stop")
        } else {
            Button(action: onSend) {
                Image(systemName: "arrow.up")
                    .font(.system(size: 14, weight: .semibold))
                    .frame(width: 36, height: 36)
            }
            .background(canSend ? Color.xAccentFill : Color.xFill, in: Circle())
            .foregroundStyle(canSend ? Color.white : Color.xText3)
            .disabled(!canSend)
            .accessibilityLabel("Send")
        }
    }
}

/// Context usage ring (trim from 12 o'clock).
struct ContextRing: View {
    let fraction: Double?

    var body: some View {
        ZStack {
            Circle().stroke(Color.xFill, lineWidth: 2.5)
            Circle()
                .trim(to: max(0, min(1, fraction ?? 0)))
                .stroke(Color.xText2, style: StrokeStyle(lineWidth: 2.5, lineCap: .round))
                .rotationEffect(.degrees(-90))
        }
        .frame(width: 16, height: 16)
    }
}