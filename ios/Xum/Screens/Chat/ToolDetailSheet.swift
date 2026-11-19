import SwiftUI
import UIKit

/// Full-height detail sheet for one tool call: Diff / File / Raw call.
struct ToolDetailSheet: View {
    let tool: ToolCall
    /// Dismiss + prefill the composer ("Ask about these lines").
    var onAsk: (String) -> Void = { _ in }
    /// Set when shown as the side panel, where there is no presentation to dismiss.
    var onClose: (() -> Void)?

    @Environment(\.dismiss) private var dismissPresentation
    private func dismiss() { if let onClose { onClose() } else { dismissPresentation() } }
    @State private var tab: Tab = .diff

    private enum Tab: String, CaseIterable {
        case diff = "Diff"
        case file = "File"
        case raw = "Raw call"
    }

    private var path: String? {
        tool.input["path"]?.string ?? tool.input["file_path"]?.string
    }

    private var title: String {
        if let path { return (path as NSString).lastPathComponent }
        return tool.name
    }

    private var counts: (added: Int, removed: Int)? { ToolMeta.editCounts(tool) }

    private var diff: [DiffLine] {
        guard let texts = ToolMeta.editTexts(tool) else { return [] }
        return Diff.build(old: texts.old, new: texts.new)
    }

    private var diffText: String {
        diff.map { "\($0)" }.joined(separator: "\n")
    }

    var body: some View {
        VStack(spacing: 0) {
            header
                .padding(.horizontal, 16)
                .padding(.top, 8)
            SegmentedTabs(options: Tab.allCases.map(\.rawValue), selection: tabBinding)
                .padding(.horizontal, 16)
                .padding(.top, 16)
            if tab == .diff, let path {
                Text(path)
                    .font(.xMono(12))
                    .foregroundStyle(Color.xText2)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.init(top: 14, leading: 16, bottom: 6, trailing: 16))
            }
            ScrollView {
                content
                    .padding(.horizontal, 10)
                    .padding(.top, 8)
                    .padding(.bottom, 16)
            }
            bottomBar
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
        }
        .background(Color.xBg)
        .presentationDetents([.large])
    }

    private var tabBinding: Binding<Int> {
        Binding(
            get: { Tab.allCases.firstIndex(of: tab) ?? 0 },
            set: { tab = Tab.allCases[$0] }
        )
    }

    private var header: some View {
        HStack {
            Button { dismiss() } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(Color.xText)
                    .frame(width: 44, height: 44)
            }
            .glassCircle()
            .accessibilityLabel("Close")
            Spacer(minLength: 8)
            VStack(spacing: 1) {
                Text(title)
                    .font(.xMono(15, weight: .semibold))
                    .foregroundStyle(Color.xText)
                    .lineLimit(1)
                subtitle
            }
            Spacer(minLength: 8)
            ShareLink(item: shareText) {
                Image(systemName: "square.and.arrow.up")
                    .font(.system(size: 17))
                    .foregroundStyle(Color.xText)
                    .frame(width: 44, height: 44)
            }
            .glassCircle()
            .accessibilityLabel("Share")
        }
    }

    private var subtitle: some View {
        HStack(spacing: 4) {
            Text(tool.name)
            if let c = counts {
                Text("·")
                Text("+\(c.added)").foregroundStyle(Color.xOk)
                Text("−\(c.removed)").foregroundStyle(Color.xBad)
            } else if let label = ToolMeta.trailingLabel(tool) {
                Text("· \(label)")
            }
        }
        .font(.xMono(12))
        .foregroundStyle(Color.xText2)
    }

    @ViewBuilder private var content: some View {
        switch tab {
        case .diff:
            if tool.name == "bash" {
                bashContent
            } else if diff.isEmpty {
                emptyText("No file changes in this call.")
            } else {
                diffView
            }
        case .file:
            if let file = fileContent {
                numberedView(file)
            } else if tool.name == "bash", let script = tool.input["script"]?.string {
                CodeBlock(code: script)
            } else {
                emptyText("This call has no file content.")
            }
        case .raw:
            VStack(alignment: .leading, spacing: 10) {
                CodeBlock(code: tool.input.prettyString)
                if let output = tool.output, !output.isNull {
                    CodeBlock(code: output.prettyString)
                }
            }
        }
    }

    private var bashContent: some View {
        VStack(alignment: .leading, spacing: 10) {
            CodeBlock(code: tool.input["script"]?.string ?? tool.input["command"]?.string ?? "")
            let out = ChatFormat.outputText(tool.output)
            if !out.isEmpty { CodeBlock(code: out) }
        }
    }

    private var fileContent: String? {
        tool.input["new_string"]?.string ?? tool.input["content"]?.string
    }

    private var diffView: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(Diff.hunkHeader(diff))
                .font(.xMono(12))
                .foregroundStyle(Color.xThink)
                .padding(.leading, 46)
                .frame(height: 26)
            ForEach(Array(diff.enumerated()), id: \.offset) { _, line in
                diffRow(line)
            }
        }
        .padding(.vertical, 6)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.xCodeBg, in: RoundedRectangle(cornerRadius: 18))
        .clipShape(RoundedRectangle(cornerRadius: 18))
        .padding(.vertical, 8)
    }

    private func diffRow(_ line: DiffLine) -> some View {
        HStack(spacing: 0) {
            Text(line.newNumber.map(String.init) ?? "")
                .foregroundStyle(Color.xText3)
                .frame(width: 28, alignment: .trailing)
                .padding(.trailing, 4)
            Text(line.kind == .context ? "" : line.sign)
                .foregroundStyle(line.kind == .add ? Color.xOk : Color.xBad)
                .frame(width: 14)
            Text(Syntax.highlight(line.text.isEmpty ? " " : line.text))
                .lineLimit(1)
                .truncationMode(.tail)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .font(.xMono(13))
        .frame(height: 22)
        .foregroundStyle(Color.xText)
        .background(rowBackground(line.kind))
    }

    private func rowBackground(_ kind: DiffLine.Kind) -> Color? {
        switch kind {
        case .context: nil
        case .del: Color.xDiffDel
        case .add: Color.xDiffAdd
        }
    }

    private func numberedView(_ text: String) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(text.components(separatedBy: "\n").enumerated()), id: \.offset) { i, line in
                    HStack(spacing: 0) {
                        Text("\(i + 1)")
                            .frame(width: 26, alignment: .trailing)
                            .foregroundStyle(Color.xText3)
                            .padding(.trailing, 6)
                        Text(line.isEmpty ? " " : line)
                            .frame(minWidth: 320, maxWidth: .infinity, alignment: .leading)
                    }
                    .font(.xMono(11.5))
                    .foregroundStyle(Color.xText)
                    .frame(height: 19)
                }
            }
            .background(Color.xCodeBg, in: RoundedRectangle(cornerRadius: 18))
            .padding(.vertical, 8)
        }
    }

    private func emptyText(_ s: String) -> some View {
        Text(s)
            .font(.system(size: 14))
            .foregroundStyle(Color.xText3)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 40)
    }

    private var shareText: String {
        if !diff.isEmpty { return diffText }
        if let script = tool.input["script"]?.string { return script }
        return ChatFormat.outputText(tool.output)
    }

    private var bottomBar: some View {
        HStack(spacing: 10) {
            HStack(spacing: 2) {
                Button {
                    UIPasteboard.general.string = shareText
                } label: {
                    Image(systemName: "doc.on.doc")
                        .font(.system(size: 14))
                        .frame(width: 40, height: 44)
                        .contentShape(Rectangle())
                }
                .accessibilityLabel("Copy diff")
                Button { } label: {
                    Image(systemName: "eye")
                        .font(.system(size: 14))
                        .frame(width: 40, height: 44)
                        .contentShape(Rectangle())
                }
                .disabled(true)
                .accessibilityLabel("Open in Review")
            }
            .glassCapsule()
            .foregroundStyle(Color.xText)
            Button {
                onAsk(askText)
                dismiss()
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: "bubble.left").font(.system(size: 13))
                    Text("Ask about these lines").font(.system(size: 15, weight: .semibold))
                }
                .frame(maxWidth: .infinity)
                .frame(height: 44)
            }
            .buttonStyle(.glassProminent)
        }
    }

    /// The reply draft the sheet seeds: the diff quoted as a code block.
    private var askText: String {
        if !diff.isEmpty {
            return "About these lines in `\(path ?? tool.name)`:\n```\n\(diffText)\n```"
        }
        return "About `\(title)`"
    }
}

/// Segmented control styled like the mockups: raised pill in a fill2 track.
struct SegmentedTabs: View {
    let options: [String]
    @Binding var selection: Int

    var body: some View {
        HStack(spacing: 0) {
            ForEach(options.indices, id: \.self) { i in
                Button { selection = i } label: {
                    Text(options[i])
                        .font(.system(size: 14, weight: i == selection ? .semibold : .regular))
                        .foregroundStyle(Color.xText)
                        .frame(maxWidth: .infinity)
                        .frame(height: 32)
                        .background {
                            if i == selection {
                                RoundedRectangle(cornerRadius: 16)
                                    .fill(Color.xRaised)
                                    .shadow(color: .black.opacity(0.12), radius: 4, y: 1)
                            }
                        }
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
        .padding(2)
        .background(Color.xFill2, in: Capsule())
    }
}

struct DiffLine {
    enum Kind { case context, del, add }
    let kind: Kind
    let oldNumber: Int?
    let newNumber: Int?
    let text: String

    var sign: String {
        switch kind {
        case .context: " "
        case .del: "-"
        case .add: "+"
        }
    }
}

extension DiffLine: CustomStringConvertible {
    var description: String { sign + " " + text }
}

/// Minimal highlighting for diff lines: keywords in accent, string literals in `code`.
enum Syntax {
    static let keywords: Set<String> = ["export", "function", "return", "const", "let", "var", "if", "else", "new", "throw",
                                        "async", "await", "import", "from", "class", "func", "struct", "for", "while", "null",
                                        "true", "false", "type", "interface"]
    static func highlight(_ line: String) -> AttributedString {
        var out = AttributedString(line)
        for m in line.matches(of: /"[^"]*"|'[^']*'|`[^`]*`/) {
            if let r = Range(m.range, in: out) { out[r].foregroundColor = Color.xCode }
        }
        for m in line.matches(of: /\b[A-Za-z]+\b/) where keywords.contains(String(m.output)) {
            if let r = Range(m.range, in: out), out[r].foregroundColor == nil { out[r].foregroundColor = Color.xAccent }
        }
        return out
    }
}

enum Diff {
    static func counts(_ lines: [DiffLine]) -> (added: Int, removed: Int) {
        (lines.filter { $0.kind == .add }.count, lines.filter { $0.kind == .del }.count)
    }

    /// `@@ -12,9 +12,12 @@` for the whole edit.
    static func hunkHeader(_ lines: [DiffLine]) -> String {
        let old = lines.filter { $0.kind != .add }.count
        let new = lines.filter { $0.kind != .del }.count
        return "@@ -1,\(old) +1,\(new) @@"
    }

    /// Line diff (LCS) between two strings; huge inputs fall back to plain removals + additions.
    static func build(old: String, new: String) -> [DiffLine] {
        var a = old.isEmpty ? [] : old.components(separatedBy: "\n")
        var b = new.isEmpty ? [] : new.components(separatedBy: "\n")
        // A trailing newline is not a content line.
        if a.last?.isEmpty == true { a.removeLast() }
        if b.last?.isEmpty == true { b.removeLast() }
        if a.isEmpty, b.isEmpty { return [] }
        if a.count * b.count > 250_000 {
            var out: [DiffLine] = []
            for (i, l) in a.enumerated() { out.append(DiffLine(kind: .del, oldNumber: i + 1, newNumber: nil, text: l)) }
            for (i, l) in b.enumerated() { out.append(DiffLine(kind: .add, oldNumber: nil, newNumber: i + 1, text: l)) }
            return out
        }
        let n = a.count, m = b.count
        var table = [[Int]](repeating: [Int](repeating: 0, count: m + 1), count: n + 1)
        for i in stride(from: n - 1, through: 0, by: -1) {
            for j in stride(from: m - 1, through: 0, by: -1) {
                table[i][j] = a[i] == b[j] ? table[i + 1][j + 1] + 1 : max(table[i + 1][j], table[i][j + 1])
            }
        }
        var out: [DiffLine] = []
        var i = 0, j = 0
        while i < n, j < m {
            if a[i] == b[j] {
                out.append(DiffLine(kind: .context, oldNumber: i + 1, newNumber: j + 1, text: a[i]))
                i += 1
                j += 1
            } else if table[i + 1][j] >= table[i][j + 1] {
                out.append(DiffLine(kind: .del, oldNumber: i + 1, newNumber: nil, text: a[i]))
                i += 1
            } else {
                out.append(DiffLine(kind: .add, oldNumber: nil, newNumber: j + 1, text: b[j]))
                j += 1
            }
        }
        while i < n {
            out.append(DiffLine(kind: .del, oldNumber: i + 1, newNumber: nil, text: a[i]))
            i += 1
        }
        while j < m {
            out.append(DiffLine(kind: .add, oldNumber: nil, newNumber: j + 1, text: b[j]))
            j += 1
        }
        return out
    }
}