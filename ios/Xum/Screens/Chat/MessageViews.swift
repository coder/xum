import SwiftUI
import UIKit

/// Formatting helpers shared by the chat screens.
enum ChatFormat {
    /// `42s`, `1m 12s`
    static func duration(_ t: TimeInterval) -> String {
        let s = max(0, Int(t))
        if s < 60 { return "\(s)s" }
        return "\(s / 60)m \(s % 60)s"
    }

    static let time: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "h:mm a"
        return f
    }()

    static func lineCount(_ s: String?) -> Int {
        guard let s, !s.isEmpty else { return 0 }
        return s.components(separatedBy: "\n").count
    }

    static func firstLine(_ s: String) -> String {
        String(s.split(separator: "\n", omittingEmptySubsequences: false).first ?? "")
    }

    /// Best-effort text of a tool result; the server's result shape varies per tool.
    static func outputText(_ output: JSONValue?) -> String {
        guard let output, !output.isNull else { return "" }
        if let t = output["text"]?.string { return t }
        if let t = output["stdout"]?.string { return t }
        if let c = output["content"]?.string { return c }
        return output.prettyString
    }
}

/// Inline markdown (bold, links, inline code). Code runs render mono in `xCode`.
struct MarkdownInline: View {
    let text: String
    var size: CGFloat = 16

    var body: some View { Text(styled) }

    private var styled: AttributedString {
        let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        var s = (try? AttributedString(markdown: text, options: options)) ?? AttributedString(text)
        for run in Array(s.runs) {
            guard let intent = run.inlinePresentationIntent, intent.contains(.code) else { continue }
            s[run.range].foregroundColor = .xCode
            s[run.range].font = .xMono(size - 1.5)
        }
        return s
    }
}

/// Fenced code block: mono 13 on `xCodeBg`, horizontally scrollable.
struct CodeBlock: View {
    let code: String

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            Text(code)
                .font(.xMono(13))
                .foregroundStyle(Color.xText)
                .textSelection(.enabled)
                .padding(12)
        }
        .background(Color.xCodeBg, in: RoundedRectangle(cornerRadius: 12))
    }
}

struct UserBubble: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.system(size: 17))
            .foregroundStyle(Color.xText)
            .textSelection(.enabled)
            .padding(.horizontal, 15)
            .padding(.vertical, 11)
            .frame(maxWidth: 300, alignment: .leading)
            .background(Color.xUser, in: RoundedRectangle(cornerRadius: 20))
            .overlay(RoundedRectangle(cornerRadius: 20).strokeBorder(Color.xSep, lineWidth: 0.5))
            .frame(maxWidth: .infinity, alignment: .trailing)
    }
}

/// Assistant message text: fenced ``` blocks split out into code blocks, the rest inline markdown.
struct AssistantTextView: View {
    let text: String

    private struct Segment: Identifiable {
        let id: Int
        let isCode: Bool
        let body: String
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(segments) { seg in
                if seg.isCode { CodeBlock(code: seg.body) } else { MarkdownInline(text: seg.body) }
            }
        }
    }

    private var segments: [Segment] {
        var out: [Segment] = []
        var md = ""
        var code = ""
        var inCode = false
        func flush() {
            if inCode {
                if !code.isEmpty { out.append(Segment(id: out.count, isCode: true, body: code)) }
                code = ""
            } else {
                let trimmed = md.trimmingCharacters(in: .whitespacesAndNewlines)
                if !trimmed.isEmpty { out.append(Segment(id: out.count, isCode: false, body: trimmed)) }
                md = ""
            }
        }
        for line in text.components(separatedBy: "\n") {
            if line.hasPrefix("```") {
                flush()
                inCode.toggle()
            } else if inCode {
                code += code.isEmpty ? line : "\n" + line
            } else {
                md += line + "\n"
            }
        }
        flush()
        return out
    }
}

/// Reasoning block: lightbulb header with live duration, italic body, blinking block cursor while
/// streaming. Expanded while it streams, collapsed once it has ended.
struct ThinkingBlock: View {
    let text: String
    let startedAt: Date?
    let endedAt: Date?
    let isStreaming: Bool

    @State private var expanded: Bool
    @State private var blink = false

    init(text: String, startedAt: Date?, endedAt: Date?, isStreaming: Bool) {
        self.text = text
        self.startedAt = startedAt
        self.endedAt = endedAt
        self.isStreaming = isStreaming
        _expanded = State(initialValue: isStreaming)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            header
            if expanded {
                HStack(alignment: .bottom, spacing: 2) {
                    Text(text)
                        .font(.system(size: 15).italic())
                        .foregroundStyle(Color.xText2)
                        .textSelection(.enabled)
                    if isStreaming {
                        Rectangle()
                            .fill(Color.xThink)
                            .frame(width: 8, height: 15)
                            .opacity(blink ? 0 : 1)
                    }
                }
            }
        }
        .padding(.horizontal, 14)
        .padding(.top, 10)
        .padding(.bottom, 14)
        .background(Color.xThink.opacity(0.08), in: RoundedRectangle(cornerRadius: 18))
        .onChange(of: isStreaming) { old, live in
            if old, !live { withAnimation(.easeOut(duration: 0.2)) { expanded = false } }
        }
        .onAppear {
            guard isStreaming else { return }
            withAnimation(.easeInOut(duration: 0.55).repeatForever(autoreverses: true)) { blink = true }
        }
    }

    private var header: some View {
        Button {
            withAnimation(.easeOut(duration: 0.2)) { expanded.toggle() }
        } label: {
            HStack(spacing: 8) {
                Image(systemName: "lightbulb").font(.system(size: 13))
                Text("Thinking").font(.system(size: 13, weight: .semibold))
                if isStreaming {
                    TimelineView(.periodic(from: .now, by: 1)) { _ in durationLabel }
                } else {
                    durationLabel
                }
                Spacer(minLength: 8)
                Image(systemName: expanded ? "chevron.up" : "chevron.down")
                    .font(.system(size: 10, weight: .semibold))
            }
            .foregroundStyle(Color.xThink)
            .frame(height: 28)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    @ViewBuilder private var durationLabel: some View {
        if let startedAt {
            let end = isStreaming ? Date() : (endedAt ?? Date())
            Text("· " + ChatFormat.duration(end.timeIntervalSince(startedAt)))
                .font(.system(size: 13))
                .opacity(0.8)
        }
    }
}

/// Copy / Fork / More + `Model · h:mm a` under the last assistant message of a turn.
struct MessageFooter: View {
    let message: ChatMessage

    var body: some View {
        HStack(spacing: 4) {
            iconButton("doc.on.doc", "Copy") { UIPasteboard.general.string = message.text }
            iconButton("arrow.triangle.branch", "Fork from here").disabled(true)
            Menu {
                Button("Copy message text") { UIPasteboard.general.string = message.text }
            } label: {
                Image(systemName: "ellipsis").font(.system(size: 13))
                    .frame(width: 36, height: 36)
            }
            .accessibilityLabel("More actions")
            Spacer(minLength: 8)
            Text(footerText)
                .font(.system(size: 12))
                .foregroundStyle(Color.xText3)
        }
        .padding(.leading, -8)
        .foregroundStyle(Color.xText3)
    }

    private var footerText: String {
        let model = ModelName.display(message.model)
        let time = message.timestamp.map { ChatFormat.time.string(from: $0) } ?? ""
        return time.isEmpty ? model : "\(model) · \(time)"
    }

    private func iconButton(_ symbol: String, _ label: String, action: @escaping () -> Void = {}) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 13))
                .frame(width: 36, height: 36)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }
}