import SwiftUI

/// Shared tool-call metadata: which rows are hidden from the group, icons, row summaries.
enum ToolMeta {
    /// Tools with dedicated UI elsewhere (todo pill, plan card, question card).
    static let hidden = ["todo_write", "propose_plan", "ask_user_question"]

    static func icon(_ name: String) -> String {
        if name == "bash" { return "terminal" }
        if name == "file_read" { return "doc.text" }
        if name.hasPrefix("file_edit") || name.hasPrefix("file_write") || name == "write" { return "pencil" }
        if name == "todo_write" { return "checklist" }
        if name.contains("web") { return "globe" }
        return "wrench.and.screwdriver"
    }

    static func summary(_ t: ToolCall) -> String {
        if t.name == "bash" {
            let script = t.input["script"]?.string ?? t.input["command"]?.string ?? ""
            return ChatFormat.firstLine(script)
        }
        if t.name.hasPrefix("file_") {
            return t.input["path"]?.string ?? t.input["file_path"]?.string ?? t.name
        }
        if case .object(let o) = t.input {
            for (_, v) in o.sorted(by: { $0.key < $1.key }) {
                if let s = v.string, !s.isEmpty { return ChatFormat.firstLine(s) }
            }
        }
        return t.name
    }

    /// Before and after text of a file edit or write; a write's `content` replaces nothing. A
    /// failed call changed nothing, so it has none.
    static func editTexts(_ t: ToolCall) -> (old: String, new: String)? {
        guard t.name.hasPrefix("file_edit") || t.name.hasPrefix("file_write") || t.name == "write", t.state != .failed else { return nil }
        return (t.input["old_string"]?.string ?? "", t.input["new_string"]?.string ?? t.input["content"]?.string ?? "")
    }

    static func editCounts(_ t: ToolCall) -> (added: Int, removed: Int)? {
        guard let texts = editTexts(t) else { return nil }
        let (added, removed) = Diff.counts(Diff.build(old: texts.old, new: texts.new))
        if added == 0, removed == 0 { return nil }
        return (added, removed)
    }

    /// `13 passed` pill for a successful bash run whose output reports passing tests.
    static func passedPill(_ t: ToolCall) -> String? {
        guard t.name == "bash", t.state == .done else { return nil }
        guard let out = ChatFormat.outputText(t.output).firstMatch(of: /[0-9]+\s+passed/) else { return nil }
        return String(out.output)
    }

    /// Trailing label shared with the tool sheet subtitle: `+24 −3`, `read`, or a duration.
    static func trailingLabel(_ t: ToolCall) -> String? {
        if let c = editCounts(t) { return "+\(c.added) −\(c.removed)" }
        if t.name == "file_read", t.state != .running { return "read" }
        return t.duration.map { ChatFormat.duration($0) }
    }
}

/// One collapsible group card for the consecutive tool calls of a message.
struct ToolGroupCard: View {
    let tools: [ToolCall]
    /// The tool shown in the regular-width inspector, highlighted in `accentSoft`.
    var inspectedId: String?
    var onTap: (ToolCall) -> Void = { _ in }

    @State private var expanded = true

    private var anyRunning: Bool { tools.contains { $0.state == .running } }
    private var anyFailed: Bool { tools.contains { $0.state == .failed } }

    private var span: TimeInterval? {
        guard let first = tools.compactMap(\.startedAt).min() else { return nil }
        let last = tools.compactMap { $0.state == .running ? Date() : $0.endedAt }.max() ?? first
        return max(0, last.timeIntervalSince(first))
    }

    var body: some View {
        VStack(spacing: 0) {
            Button {
                withAnimation(.easeOut(duration: 0.2)) { expanded.toggle() }
            } label: { headerRow }
                .buttonStyle(.plain)
            if expanded {
                VStack(spacing: 0) {
                    ForEach(tools) { tool in
                        ToolRow(tool: tool) { onTap(tool) }
                            .background(
                                tool.id == inspectedId ? Color.xAccentSoft : .clear,
                                in: RoundedRectangle(cornerRadius: 10, style: .continuous)
                            )
                    }
                }
                .padding(.bottom, 6)
            }
        }
        .padding(.horizontal, 12)
        .padding(.top, 4)
        .background(Color.xFill2, in: RoundedRectangle(cornerRadius: 18))
    }

    private var headerRow: some View {
        HStack(spacing: 8) {
            Image(systemName: "chevron.right")
                .font(.system(size: 10, weight: .semibold))
                .rotationEffect(.degrees(expanded ? 90 : 0))
            Text(tools.count == 1 ? "1 step" : "\(tools.count) steps").fontWeight(.medium)
            if let span { Text("· " + ChatFormat.duration(span)).foregroundStyle(Color.xText3) }
            Spacer(minLength: 8)
            statusLabel
        }
        .font(.system(size: 13))
        .foregroundStyle(Color.xText2)
        .frame(height: 32)
        .contentShape(Rectangle())
    }

    @ViewBuilder private var statusLabel: some View {
        if anyRunning {
            HStack(spacing: 6) {
                Text("Running…")
                ProgressView().controlSize(.small).tint(.xAccent)
            }
        } else if anyFailed {
            Text("Failed").foregroundStyle(Color.xBad)
        } else {
            Text("Done").foregroundStyle(Color.xOk)
        }
    }
}

/// One row of a tool group card, plus the live output block of a running bash call.
struct ToolRow: View {
    let tool: ToolCall
    var onTap: () -> Void = {}

    var body: some View {
        VStack(spacing: 0) {
            Button(action: onTap) { row }.buttonStyle(.plain)
            if tool.name == "bash", tool.state == .running, !tool.liveOutput.isEmpty {
                LiveOutput(text: tool.liveOutput).padding(.vertical, 6)
            }
        }
    }

    private var row: some View {
        HStack(spacing: 10) {
            Image(systemName: ToolMeta.icon(tool.name)).font(.system(size: 12))
            Text(ToolMeta.summary(tool))
                .font(.xMono(13))
                .foregroundStyle(Color.xText)
                .lineLimit(1)
                .truncationMode(.middle)
            Spacer(minLength: 8)
            trailing
            statusIcon
        }
        .frame(minHeight: 34)
        .contentShape(Rectangle())
    }

    @ViewBuilder private var trailing: some View {
        if let pill = ToolMeta.passedPill(tool) {
            Text(pill)
                .font(.system(size: 11.5))
                .foregroundStyle(Color.xOk)
                .padding(.horizontal, 7)
                .frame(height: 20)
                .background(Color.xDiffAdd, in: Capsule())
        } else if let counts = ToolMeta.editCounts(tool) {
            HStack(spacing: 4) {
                Text("+\(counts.added)").foregroundStyle(Color.xOk)
                Text("−\(counts.removed)").foregroundStyle(Color.xBad)
            }
            .font(.xMono(13))
        } else if tool.state == .running {
            TimelineView(.periodic(from: .now, by: 1)) { _ in
                durationText
            }
        } else if let label = ToolMeta.trailingLabel(tool) {
            Text(label).font(.xMono(13)).foregroundStyle(Color.xText3)
        }
    }

    private var durationText: some View {
        Text(tool.duration.map { ChatFormat.duration($0) } ?? "")
            .font(.xMono(13))
            .foregroundStyle(Color.xText3)
    }

    @ViewBuilder private var statusIcon: some View {
        switch tool.state {
        case .running:
            ProgressView().controlSize(.small).tint(.xAccent)
        case .done:
            Image(systemName: "checkmark").font(.system(size: 12, weight: .semibold)).foregroundStyle(Color.xOk)
        case .failed:
            Image(systemName: "xmark").font(.system(size: 12, weight: .semibold)).foregroundStyle(Color.xBad)
        }
    }
}

/// Last lines of a running bash call; RUNS lines in warn, PASS lines in ok.
struct LiveOutput: View {
    let text: String

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
                Text(line)
                    .font(.xMono(12))
                    .foregroundStyle(color(for: line))
                    .lineLimit(1)
                    .frame(height: 18)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(9)
        .background(Color.xCodeBg, in: RoundedRectangle(cornerRadius: 12))
    }

    private var lines: [String] {
        Array(text.split(separator: "\n", omittingEmptySubsequences: true).suffix(6).map(String.init))
    }

    private func color(for line: String) -> Color {
        if line.contains("RUNS") { return .xWarn }
        if line.contains("PASS") { return .xOk }
        return .xText2
    }
}