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

/// A user message's attachment, by name and type, under its bubble.
struct AttachmentChip: View {
    let file: AttachedFile

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: file.mediaType.hasPrefix("image/") ? "photo" : "paperclip")
                .font(.system(size: 13))
                .foregroundStyle(Color.xText2)
            Text(file.name)
                .font(.system(size: 14))
                .foregroundStyle(Color.xText)
                .lineLimit(1)
                .truncationMode(.middle)
            if !file.mediaType.isEmpty {
                Text(file.mediaType).font(.system(size: 12)).foregroundStyle(Color.xText3).lineLimit(1)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 7)
        .frame(maxWidth: 300, alignment: .leading)
        .background(Color.xUser, in: Capsule())
        .overlay(Capsule().strokeBorder(Color.xSep, lineWidth: 0.5))
        .frame(maxWidth: .infinity, alignment: .trailing)
        .accessibilityElement(children: .combine)
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
                if seg.isCode { CodeBlock(code: seg.body) } else { MarkdownBlocks(text: seg.body) }
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
                if isStreaming {
                    // Live reasoning shows only its newest lines in a fixed-height window, so
                    // the block does not grow past the screen and push the stream out of view
                    // while it is still being written.
                    // The cursor is part of the text so it sits at the end of the last line.
                    TimelineView(.periodic(from: .now, by: 0.55)) { ctx in
                        let on = Int(ctx.date.timeIntervalSinceReferenceDate / 0.55) % 2 == 0
                        (Text(text) + Text(" \u{258D}").foregroundStyle(Color.xThink.opacity(on ? 1 : 0)))
                            .font(.system(size: 15).italic())
                            .foregroundStyle(Color.xText2)
                            .fixedSize(horizontal: false, vertical: true)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .frame(maxHeight: Self.liveHeight, alignment: .bottom)
                    .clipped()
                    .mask {
                        // Fade the cut-off top edge only once the text overflows the window.
                        if text.count > 280 || ChatFormat.lineCount(text) > 6 {
                            LinearGradient(stops: [.init(color: .clear, location: 0), .init(color: .black, location: 0.3)],
                                           startPoint: .top, endPoint: .bottom)
                        } else {
                            Color.black
                        }
                    }
                } else {
                    thinkingText.textSelection(.enabled)
                }
            }
        }
        .padding(.horizontal, 14)
        .padding(.top, 10)
        .padding(.bottom, 14)
        .background(Color.xThink.opacity(0.08), in: RoundedRectangle(cornerRadius: 18))
        .onChange(of: isStreaming) { old, live in
            if old, !live { withAnimation(.easeOut(duration: 0.2)) { expanded = false } }
            if !old, live { expanded = true }
        }
    }

    private static let liveHeight: CGFloat = 132

    private var thinkingText: some View {
        Text(text)
            .font(.system(size: 15).italic())
            .foregroundStyle(Color.xText2)
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
        if let startedAt, isStreaming || (endedAt ?? Date()).timeIntervalSince(startedAt) >= 1 {
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
/// The `/compact` request row: a short centered marker instead of the long summarization prompt.
struct CompactionRequestMarker: View {
    let command: String

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "arrow.down.right.and.arrow.up.left").font(.system(size: 11, weight: .semibold))
            Text(command).font(.xMono(12, weight: .medium))
        }
        .foregroundStyle(Color.xText2)
        .padding(.horizontal, 12)
        .frame(height: 28)
        .background(Color.xFill2, in: Capsule())
        .frame(maxWidth: .infinity)
    }
}

/// Compaction summary: what the agent keeps of the history before it. Collapsed to a few lines,
/// with a live "Compacting" state while the summary streams.
struct CompactionCard: View {
    let message: ChatMessage
    let source: String

    @State private var expanded = false

    private var title: String {
        if message.isStreaming { return "Compacting conversation" }
        switch source {
        case "idle": return "Idle-compacted"
        case "auto": return "Auto-compacted"
        case "heartbeat": return "Compacted by heartbeat"
        default: return "Conversation compacted"
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Button {
                withAnimation(.easeOut(duration: 0.2)) { expanded.toggle() }
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: "arrow.down.right.and.arrow.up.left").font(.system(size: 13, weight: .semibold))
                    Text(title).font(.system(size: 14, weight: .semibold))
                    if message.isStreaming { ProgressView().controlSize(.mini) }
                    Spacer(minLength: 8)
                    if let t = message.timestamp {
                        Text(ChatFormat.time.string(from: t)).font(.system(size: 12)).foregroundStyle(Color.xText3)
                    }
                    Image(systemName: expanded ? "chevron.up" : "chevron.down").font(.system(size: 10, weight: .semibold))
                }
                .foregroundStyle(Color.xAccent)
                .frame(minHeight: 28)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            Text("Earlier messages were summarized so the agent can keep going with a smaller context.")
                .font(.system(size: 13))
                .foregroundStyle(Color.xText2)
            if !message.text.isEmpty {
                Group {
                    if expanded {
                        AssistantTextView(text: message.text)
                    } else {
                        Text(message.text)
                            .font(.system(size: 14))
                            .foregroundStyle(Color.xText)
                            .lineLimit(4)
                    }
                }
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.xBg, in: RoundedRectangle(cornerRadius: 12))
                if !expanded, message.text.count > 240 || ChatFormat.lineCount(message.text) > 4 {
                    Button("Show summary") { withAnimation(.easeOut(duration: 0.2)) { expanded = true } }
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(Color.xAccent)
                }
            }
        }
        .padding(14)
        .background(Color.xAccentSoft, in: RoundedRectangle(cornerRadius: 18))
    }
}

/// Top-of-transcript control for the rows before the oldest loaded one.
struct LoadOlderButton: View {
    let loading: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                if loading { ProgressView().controlSize(.mini) } else { Image(systemName: "clock.arrow.circlepath") }
                Text(loading ? "Loading…" : "Earlier messages")
            }
            .font(.system(size: 13, weight: .medium))
            .foregroundStyle(Color.xText2)
            .padding(.horizontal, 14)
            .frame(height: 32)
            .background(Color.xFill2, in: Capsule())
        }
        .buttonStyle(.plain)
        .disabled(loading)
        .frame(maxWidth: .infinity)
    }
}

/// Markdown prose: headings and list items get their own lines (AttributedString's inline
/// parsing leaves `#` and `-` as literal text); everything else is inline markdown.
struct MarkdownBlocks: View {
    let text: String

    private enum Block {
        case heading(Int, String)
        case bullet(String, String)
        case paragraph(String)
    }

    var body: some View {
        let blocks = parse()
        VStack(alignment: .leading, spacing: 6) {
            ForEach(blocks.indices, id: \.self) { i in
                switch blocks[i] {
                case .heading(let level, let t):
                    MarkdownInline(text: t, size: level == 1 ? 20 : level == 2 ? 18 : 16)
                        .font(.system(size: level == 1 ? 20 : level == 2 ? 18 : 16, weight: .semibold))
                        .padding(.top, i == 0 ? 0 : 6)
                case .bullet(let marker, let t):
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(marker).foregroundStyle(Color.xText2)
                        MarkdownInline(text: t)
                    }
                    .padding(.leading, 4)
                case .paragraph(let t):
                    MarkdownInline(text: t)
                }
            }
        }
    }

    private func parse() -> [Block] {
        var out: [Block] = []
        var para: [String] = []
        func flush() {
            if !para.isEmpty { out.append(.paragraph(para.joined(separator: "\n"))) }
            para = []
        }
        for raw in text.components(separatedBy: "\n") {
            let line = raw.trimmingCharacters(in: .whitespaces)
            if let m = line.wholeMatch(of: /(#{1,6})\s+(.*)/) {
                flush()
                out.append(.heading(m.1.count, String(m.2)))
            } else if let m = line.wholeMatch(of: /[-*+]\s+(.*)/) {
                flush()
                out.append(.bullet("•", String(m.1)))
            } else if let m = line.wholeMatch(of: /(\d+[.)])\s+(.*)/) {
                flush()
                out.append(.bullet(String(m.1), String(m.2)))
            } else if line.isEmpty {
                flush()
            } else {
                para.append(raw)
            }
        }
        flush()
        return out
    }
}
