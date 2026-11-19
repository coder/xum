import SwiftUI

/// `propose_plan` tool as a plan card with an Implement action (only on the latest plan).
struct PlanCard: View {
    let tool: ToolCall
    let modelName: String?
    let timestamp: Date?
    let canImplement: Bool
    var onImplement: () -> Void = {}

    private struct Line: Identifiable {
        enum Kind { case heading, subheading, bullet, ordered, paragraph }
        let id: Int
        let kind: Kind
        let number: Int?
        let text: String
    }

    private var markdown: String {
        tool.input["plan"]?.string ?? tool.output?["planContent"]?.string ?? ""
    }

    private var title: String {
        if let t = tool.input["title"]?.string, !t.isEmpty { return t }
        for line in markdown.components(separatedBy: "\n") where line.trimmingCharacters(in: .whitespaces).hasPrefix("# ") {
            return String(line.drop(while: { $0 == "#" || $0 == " " })).trimmingCharacters(in: .whitespaces)
        }
        return "Plan"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Text("PLAN")
                    .font(.xCaption)
                    .kerning(0.4)
                    .foregroundStyle(Color.xPlan)
                Text(metaText).font(.system(size: 12)).foregroundStyle(Color.xText3)
                Spacer(minLength: 0)
            }
            Text(title)
                .font(.xCardTitle)
                .foregroundStyle(Color.xText)
                .padding(.top, 6)
            ForEach(lines) { line in
                lineView(line).padding(.top, line.kind == .heading || line.kind == .subheading ? 12 : 4)
            }
            if !markdown.isEmpty { Divider().overlay(Color.xPlanLine).padding(.top, 14) }
            HStack(alignment: .center, spacing: 10) {
                Text("Revise in chat, or switch to Exec to implement.")
                    .font(.xMono(11.5))
                    .italic()
                    .foregroundStyle(Color.xText2)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if canImplement {
                    Button(action: onImplement) {
                        HStack(spacing: 6) {
                            Image(systemName: "play.fill").font(.system(size: 10))
                            Text("Implement").font(.system(size: 14, weight: .semibold))
                        }
                        .foregroundStyle(Color.xPlan)
                        .padding(.horizontal, 14)
                        .frame(height: 36)
                        .overlay(Capsule().strokeBorder(Color.xPlanLine, lineWidth: 1))
                        .contentShape(Capsule())
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.top, 12)
        }
        .padding(16)
        .background(Color.xPlanSoft, in: RoundedRectangle(cornerRadius: 20))
        .overlay(RoundedRectangle(cornerRadius: 20).strokeBorder(Color.xPlanLine, lineWidth: 1))
    }

    private var metaText: String {
        var parts: [String] = []
        if let modelName { parts.append(ModelName.display(modelName)) }
        if let timestamp { parts.append(ChatFormat.time.string(from: timestamp)) }
        return parts.isEmpty ? "" : "· " + parts.joined(separator: " · ")
    }

    /// Body rendered line by line: headings, `1.` ordered items, `-` bullets, paragraphs.
    private var lines: [Line] {
        var out: [Line] = []
        // The first `# ` heading is the card title; skip it when the title came from it.
        var titleIsFirstHeading = tool.input["title"]?.string == nil
        for raw in markdown.components(separatedBy: "\n") {
            let t = raw.trimmingCharacters(in: .whitespaces)
            if t.isEmpty { continue }
            let id = out.count
            if t.hasPrefix("## ") || t.hasPrefix("### ") {
                let text = t.drop { $0 == "#" || $0 == " " }
                out.append(Line(id: id, kind: .subheading, number: nil, text: String(text)))
            } else if t.hasPrefix("# ") {
                if titleIsFirstHeading { titleIsFirstHeading = false; continue }
                out.append(Line(id: id, kind: .heading, number: nil, text: String(t.dropFirst(2)).trimmingCharacters(in: .whitespaces)))
            } else if t.hasPrefix("- ") || t.hasPrefix("* ") {
                out.append(Line(id: id, kind: .bullet, number: nil, text: String(t.dropFirst(2))))
            } else if let m = t.firstMatch(of: /^([0-9]+)\.\s+(.*)$/) {
                let n = Int(m.1) ?? 1
                out.append(Line(id: id, kind: .ordered, number: n, text: String(m.2)))
            } else {
                out.append(Line(id: id, kind: .paragraph, number: nil, text: t))
            }
        }
        return out
    }

    @ViewBuilder private func lineView(_ l: Line) -> some View {
        switch l.kind {
        case .heading:
            MarkdownInline(text: l.text, size: 17).font(.system(size: 17, weight: .bold)).foregroundStyle(Color.xText)
        case .subheading:
            MarkdownInline(text: l.text, size: 15).font(.system(size: 15, weight: .semibold)).foregroundStyle(Color.xPlan)
        case .bullet:
            HStack(alignment: .top, spacing: 8) {
                Text("•").font(.system(size: 15))
                MarkdownInline(text: l.text, size: 15).font(.system(size: 15)).foregroundStyle(Color.xText)
            }
        case .ordered:
            HStack(alignment: .top, spacing: 8) {
                Text("\(l.number ?? 1).").font(.system(size: 15)).monospacedDigit()
                MarkdownInline(text: l.text, size: 15).font(.system(size: 15)).foregroundStyle(Color.xText)
            }
        case .paragraph:
            MarkdownInline(text: l.text, size: 15).font(.system(size: 15)).foregroundStyle(Color.xText)
        }
    }
}

/// Replaces the composer while an `ask_user_question` call is open; collects one answer per
/// question ("" for skipped) and submits them all at the end.
struct QuestionCard: View {
    let question: PendingQuestion
    /// Full-height side panel on the Duo inner display (docs/04 screen 02): larger question, a
    /// preview of the next one, Skip / Next pinned to the bottom.
    var panel = false
    var onSubmit: ([String: String]) -> Void = { _ in }

    @State private var index = 0
    /// Question index to chosen option index; -1 = custom text, -2 = skipped.
    @State private var selections: [Int: Int] = [:]
    @State private var customText: [Int: String] = [:]
    /// Chosen option indexes of multi-select questions; the custom row stays in `selections`.
    @State private var picked: [Int: Set<Int>] = [:]

    private var q: PendingQuestion.Question { question.questions[index] }
    private var isLast: Bool { index == question.questions.count - 1 }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                StatusDot(color: .xWarn, size: 8)
                Text("WAITING ON YOU")
                    .font(.xCaption)
                    .kerning(0.4)
                    .foregroundStyle(Color.xWarn)
                Spacer(minLength: 8)
                Text("\(index + 1) of \(question.questions.count)")
                    .font(.system(size: 12.5))
                    .foregroundStyle(Color.xText3)
            }
            Text(q.question)
                .font(.system(size: panel ? 22 : 17, weight: .semibold))
                .foregroundStyle(Color.xText)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, panel ? 12 : 8)
            VStack(spacing: 8) {
                ForEach(q.options.indices, id: \.self) { i in
                    optionRow(i)
                }
                customRow
            }
            .padding(.top, 12)
            if panel {
                if !isLast {
                    Divider().padding(.top, 16)
                    HStack(alignment: .firstTextBaseline, spacing: 10) {
                        Text("NEXT").font(.xCaption).kerning(0.4).foregroundStyle(Color.xText3)
                        Text(question.questions[index + 1].question)
                            .font(.system(size: 15))
                            .foregroundStyle(Color.xText2)
                    }
                    .padding(.top, 14)
                }
                Spacer(minLength: 16)
            }
            HStack(spacing: 10) {
                Button(action: skip) {
                    Text("Skip")
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(Color.xText)
                        .padding(.horizontal, 22)
                        .frame(height: 48)
                        .background(Color.xFill, in: Capsule())
                        .contentShape(Capsule())
                }
                .buttonStyle(.plain)
                Button(action: advance) {
                    Text(isLast ? "Submit" : "Next")
                        .font(.system(size: 16, weight: .semibold))
                        .frame(maxWidth: .infinity)
                        .frame(height: 48)
                }
                .buttonStyle(.glassProminent)
            }
            .padding(.top, 14)
        }
        .padding(.init(top: 18, leading: 16, bottom: 14, trailing: 16))
        .modifier(QuestionChrome(panel: panel))
    }

    private struct QuestionChrome: ViewModifier {
        let panel: Bool
        func body(content: Content) -> some View {
            if panel { content.frame(maxHeight: .infinity, alignment: .top) } else { content.glassRect(28) }
        }
    }

    private func defaultSelection(_ i: Int) -> Int {
        let opts = question.questions[i].options
        if let rec = opts.firstIndex(where: { $0.label.contains("(Recommended)") }) { return rec }
        return opts.isEmpty ? -1 : 0
    }

    private var selection: Int { selections[index] ?? defaultSelection(index) }

    private func pickedOptions(_ i: Int) -> Set<Int> {
        if let set = picked[i] { return set }
        let d = defaultSelection(i)
        return d >= 0 ? [d] : []
    }

    private func optionRow(_ i: Int) -> some View {
        let option = q.options[i]
        let selected = q.multiSelect ? pickedOptions(index).contains(i) : selection == i
        return Button {
            if q.multiSelect {
                var set = pickedOptions(index)
                if set.contains(i) { set.remove(i) } else { set.insert(i) }
                picked[index] = set
                if selections[index] == -2 { selections[index] = nil }
            } else {
                selections[index] = i
            }
        } label: {
            HStack(alignment: .center, spacing: 12) {
                radioDot(selected: selected, square: q.multiSelect)
                VStack(alignment: .leading, spacing: 2) {
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text(displayLabel(option.label))
                            .font(.system(size: 15, weight: .medium))
                        if option.label.contains("(Recommended)") {
                            Text("RECOMMENDED")
                                .font(.system(size: 10.5, weight: .semibold))
                                .kerning(0.4)
                                .foregroundStyle(Color.xAccent)
                        }
                    }
                    if !option.description.isEmpty {
                        Text(option.description)
                            .font(.system(size: 13))
                            .foregroundStyle(Color.xText2)
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .background(selected ? Color.xAccentSoft : Color.xFill2, in: RoundedRectangle(cornerRadius: 18))
            .overlay(RoundedRectangle(cornerRadius: 18).strokeBorder(selected ? Color.xAccent : .clear, lineWidth: 1.5))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(Color.xText)
    }

    @ViewBuilder private var customRow: some View {
        if selection == -1 {
            HStack(spacing: 12) {
                radioDot(selected: true, square: q.multiSelect)
                TextField("Type your answer…", text: Binding(
                    get: { customText[index] ?? "" },
                    set: { customText[index] = $0 }
                ))
                .font(.system(size: 15))
            }
            .padding(.horizontal, 14)
            .frame(minHeight: 44)
            .background(Color.xAccentSoft, in: RoundedRectangle(cornerRadius: 18))
            .overlay(RoundedRectangle(cornerRadius: 18).strokeBorder(Color.xAccent, lineWidth: 1.5))
        } else {
            Button {
                selections[index] = -1
            } label: {
                HStack(spacing: 12) {
                    radioDot(selected: false, square: q.multiSelect)
                    Text("Something else…")
                        .font(.system(size: 15))
                        .foregroundStyle(Color.xText2)
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 14)
                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                .background(Color.xFill2, in: RoundedRectangle(cornerRadius: 18))
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        }
    }

    /// A square marks a multi-select option (a checkbox), a circle a single choice.
    private func radioDot(selected: Bool, square: Bool = false) -> some View {
        let shape = RoundedRectangle(cornerRadius: square ? 5 : 10)
        return ZStack {
            shape.strokeBorder(Color.xText3, lineWidth: 1.5)
            if selected { RoundedRectangle(cornerRadius: square ? 2.5 : 5).fill(Color.xAccent).frame(width: 10, height: 10) }
        }
        .frame(width: 20, height: 20)
    }

    /// `(Recommended)` is a marker, not copy for the answer.
    private func displayLabel(_ label: String) -> String {
        label
            .replacingOccurrences(of: " (Recommended)", with: "")
            .replacingOccurrences(of: "(Recommended)", with: "")
            .trimmingCharacters(in: .whitespaces)
    }

    private func skip() {
        selections[index] = -2
        if isLast { submit() } else { index += 1 }
    }

    private func advance() {
        if isLast { submit() } else { index += 1 }
    }

    private func submit() {
        var answers: [String: String] = [:]
        for (i, q) in question.questions.enumerated() {
            if q.multiSelect, selections[i] != -2 {
                // Same serialization as the desktop form: chosen labels, then the custom text.
                var parts = pickedOptions(i).sorted().filter(q.options.indices.contains).map { q.options[$0].label }
                if selections[i] ?? defaultSelection(i) == -1, let t = customText[i], !t.isEmpty { parts.append(t) }
                answers[q.question] = parts.joined(separator: ", ")
                continue
            }
            switch selections[i] ?? defaultSelection(i) {
            case -1: answers[q.question] = customText[i] ?? ""
            case -2: answers[q.question] = ""
            case let sel: answers[q.question] = q.options.indices.contains(sel) ? q.options[sel].label : ""
            }
        }
        onSubmit(answers)
    }
}

/// Pinned TODO pill above the composer; the chevron expands the full list.
struct TodoPill: View {
    let todos: [TodoItem]
    let isStreaming: Bool

    @State private var expanded = false

    private var current: TodoItem? {
        todos.first { $0.status == "in_progress" } ?? todos.first { $0.status != "completed" }
    }

    private var completedCount: Int { todos.filter { $0.status == "completed" }.count }

    var body: some View {
        VStack(spacing: 8) {
            if expanded { expandedList }
            if current != nil {
                Button {
                    withAnimation(.easeOut(duration: 0.2)) { expanded.toggle() }
                } label: { pill }
                    .buttonStyle(.plain)
            }
        }
    }

    private var pill: some View {
        HStack(spacing: 10) {
            if isStreaming {
                ProgressView().controlSize(.small).tint(.xAccent)
            } else {
                StatusDot(color: .xAccent, size: 8)
            }
            Text(current?.content ?? "")
                .font(.system(size: 14))
                .foregroundStyle(Color.xText)
                .lineLimit(1)
            Spacer(minLength: 8)
            Text("TODO \(completedCount)/\(todos.count)")
                .font(.xCaption)
                .foregroundStyle(Color.xText2)
            Image(systemName: expanded ? "chevron.up" : "chevron.down")
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(Color.xText2)
        }
        .padding(.horizontal, 14)
        .frame(height: 44)
        .glassCapsule()
        .contentShape(Capsule())
    }

    private var expandedList: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(todos.enumerated()), id: \.offset) { _, todo in
                HStack(alignment: .top, spacing: 10) {
                    statusIcon(todo.status)
                    Text(todo.content)
                        .font(.system(size: 14))
                        .lineLimit(2)
                }
                .foregroundStyle(todo.status == "completed" ? Color.xText3 : Color.xText)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassRect(20)
    }

    @ViewBuilder private func statusIcon(_ status: String) -> some View {
        if status == "completed" {
            Image(systemName: "checkmark").font(.system(size: 11, weight: .semibold)).foregroundStyle(Color.xOk)
        } else if status == "in_progress" {
            ProgressView().controlSize(.small).tint(.xAccent)
        } else {
            Circle().strokeBorder(Color.xText3, lineWidth: 1.5).frame(width: 14, height: 14)
        }
    }
}
/// A bash call the sandbox blocked: the user lets it run once outside, or denies it. Same
/// choice and wording as the desktop SandboxApprovalCard.
struct SandboxApprovalCard: View {
    let approval: SandboxApproval
    var onAnswer: (Bool) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Image(systemName: "lock.trianglebadge.exclamationmark").foregroundStyle(Color.xWarn)
                Text("SANDBOX BLOCKED A COMMAND").font(.xCaption).kerning(0.4).foregroundStyle(Color.xWarn)
            }
            if !approval.reason.isEmpty {
                Text(approval.reason).font(.system(size: 15)).foregroundStyle(Color.xText)
                    .fixedSize(horizontal: false, vertical: true)
            }
            ScrollView {
                Text(approval.script).font(.xMono(12.5)).foregroundStyle(Color.xText2).textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(10)
            }
            .frame(maxHeight: 120)
            .background(Color.xFill2, in: RoundedRectangle(cornerRadius: 12))
            Text("Runs once outside the sandbox, with full access to your files, keys and network.")
                .font(.system(size: 13)).foregroundStyle(Color.xText2)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 10) {
                Button { onAnswer(false) } label: {
                    Text("Deny").font(.system(size: 16, weight: .semibold)).foregroundStyle(Color.xText)
                        .padding(.horizontal, 22).frame(height: 48)
                        .background(Color.xFill, in: Capsule()).contentShape(Capsule())
                }
                .buttonStyle(.plain)
                Button { onAnswer(true) } label: {
                    Text("Run outside once").font(.system(size: 16, weight: .semibold))
                        .frame(maxWidth: .infinity).frame(height: 48)
                }
                .buttonStyle(.glassProminent)
            }
        }
        .padding(.init(top: 16, leading: 16, bottom: 14, trailing: 16))
        .glassRect(28)
    }
}

/// A message the server returned unsent: put it back in the composer or drop it.
struct HeldInputRow: View {
    let held: HeldInput
    var onRestore: () -> Void
    var onDiscard: () -> Void

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "arrow.uturn.backward.circle").foregroundStyle(Color.xWarn)
            VStack(alignment: .leading, spacing: 1) {
                Text("Not sent").font(.xCaption).foregroundStyle(Color.xWarn)
                Text(held.text.isEmpty ? "Attachments only" : held.text)
                    .font(.system(size: 14)).foregroundStyle(Color.xText).lineLimit(2)
            }
            Spacer(minLength: 8)
            if !held.text.isEmpty {
                Button("Restore", action: onRestore).font(.system(size: 14, weight: .semibold)).buttonStyle(.glass)
            }
            Button(action: onDiscard) {
                Image(systemName: "xmark").font(.system(size: 13, weight: .semibold)).frame(width: 32, height: 32)
            }
            .buttonStyle(.plain)
            .foregroundStyle(Color.xText2)
            .accessibilityLabel("Discard")
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .glassRect(20)
    }
}
