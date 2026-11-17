import SwiftUI
import UIKit

/// Chat for one workspace: message list, tool groups, plan and question cards, composer.
struct ChatView: View {
    let workspaceId: String

    @Environment(AppModel.self) private var model
    @Environment(\.horizontalSizeClass) private var sizeClass
    @State private var store: ChatStore?
    @State private var draft = ""
    @State private var agent = "exec"
    @State private var modelId = "anthropic:claude-opus-5-5"
    @State private var thinking: ThinkingLevel = .medium
    @State private var selectedTool: ToolCall?
    @State private var seeded = false

    private var workspace: Workspace? { model.list?.workspace(workspaceId) }
    private var serverName: String { model.servers.current?.name ?? "" }

    var body: some View {
        Group {
            if let store {
                chat(store)
            } else {
                Color.xBg
            }
        }
        .background { Color.xBg.ignoresSafeArea() }
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { toolbarContent }
        .toolbar(.hidden, for: .tabBar)
        .onAppear(perform: attach)
        // Regular width (iPhone Duo inner display): the tool detail is a persistent inspector
        // beside the chat instead of a modal sheet; tapping another row swaps its content.
        .sheet(item: sizeClass == .regular ? .constant(nil) : $selectedTool) { tool in
            ToolDetailSheet(tool: tool) { prefill in
                draft = prefill
            }
        }
        .inspector(isPresented: Binding(get: { sizeClass == .regular && selectedTool != nil }, set: { if !$0 { selectedTool = nil } })) {
            if let tool = selectedTool {
                ToolDetailSheet(tool: tool) { prefill in
                    draft = prefill
                }
                .id(tool.id)
                .inspectorColumnWidth(min: 360, ideal: 400, max: 440)
            }
        }
    }

    // MARK: - Setup

    private func attach() {
        guard !seeded else { return }
        seeded = true
        store = model.chatStore(workspaceId)
        seedSettings()
    }

    /// Agent/model/thinking start from the workspace's saved per-agent settings, then app defaults.
    private func seedSettings() {
        func setting(_ key: String) -> String? {
            workspace?.raw["aiSettingsByAgent"]?[model.defaultAgent]?[key]?.string
        }
        agent = model.defaultAgent
        modelId = setting("model") ?? model.defaultModel
        if let s = setting("thinkingLevel"), let level = ThinkingLevel(rawValue: s) {
            thinking = level
        } else {
            thinking = model.defaultThinking
        }
    }

    // MARK: - Layout

    private func chat(_ store: ChatStore) -> some View {
        VStack(spacing: 0) {
            if let error = store.lastError {
                banner(error, tint: .xBad, icon: "exclamationmark.triangle")
            }
            if let connection = store.connectionError {
                banner(connection, tint: .xWarn, icon: "wifi.exclamationmark")
            }
            messages(store)
        }
        .safeAreaInset(edge: .bottom, spacing: 0) { bottomArea(store) }
    }

    private func messages(_ store: ChatStore) -> some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 14) {
                    ForEach(store.messages) { message in
                        messageRow(message, store: store)
                    }
                    Color.clear.frame(height: 1).id("chat-bottom")
                }
                .padding(.horizontal, 16)
                .padding(.top, 8)
                .padding(.bottom, 8)
            }
            .defaultScrollAnchor(.bottom)
            .onChange(of: autoscrollKey(store)) { _, _ in
                withAnimation(.easeOut(duration: 0.25)) { proxy.scrollTo("chat-bottom", anchor: .bottom) }
            }
        }
    }

    /// Content signature that changes while a message streams, so the list follows the stream.
    private func autoscrollKey(_ store: ChatStore) -> Int {
        var key = store.messages.count
        if let last = store.messages.last {
            key = key &* 31 &+ last.parts.count &+ last.text.count % 997 &+ (last.isStreaming ? 1 : 0)
        }
        return key
    }

    @ViewBuilder private func messageRow(_ m: ChatMessage, store: ChatStore) -> some View {
        if m.role == .user {
            if !m.text.isEmpty { UserBubble(text: m.text) }
        } else {
            VStack(alignment: .leading, spacing: 10) {
                ForEach(bodyElements(m)) { element in
                    elementView(element, message: m, store: store)
                }
                if showFooter(m, in: store.messages) {
                    MessageFooter(message: m)
                }
            }
        }
    }

    private struct BodyElement: Identifiable {
        enum Kind {
            case text(String)
            case reasoning(String, live: Bool)
            case tools([ToolCall])
            case plan(ToolCall)
        }
        let id: String
        let kind: Kind
    }

    /// Message parts with consecutive tool calls collapsed into group / plan elements.
    private func bodyElements(_ m: ChatMessage) -> [BodyElement] {
        var out: [BodyElement] = []
        var run: [ToolCall] = []
        var thinkingIndex: Int?
        func flush() {
            var group: [ToolCall] = []
            func pushGroup() {
                if !group.isEmpty {
                    out.append(BodyElement(id: "grp-" + group.map(\.id).joined(separator: "-"), kind: .tools(group)))
                    group = []
                }
            }
            for tool in run {
                if tool.name == "propose_plan" {
                    pushGroup()
                    out.append(BodyElement(id: tool.id, kind: .plan(tool)))
                } else if !ToolMeta.hidden.contains(tool.name) {
                    group.append(tool)
                }
            }
            pushGroup()
            run = []
        }
        for part in m.parts {
            switch part {
            case .text(_, let t):
                if !run.isEmpty { flush() }
                if !t.isEmpty { out.append(BodyElement(id: part.id, kind: .text(t))) }
            case .reasoning(_, let t):
                // All of a turn's reasoning shows as one Thinking block where it first began, so
                // tool calls separated only by more thinking stay in one group (as designed).
                guard !t.isEmpty else { continue }
                if let i = thinkingIndex, case .reasoning(let prev, _) = out[i].kind {
                    out[i] = BodyElement(id: out[i].id, kind: .reasoning(prev + "\n\n" + t, live: false))
                } else {
                    if !run.isEmpty { flush() }
                    thinkingIndex = out.count
                    out.append(BodyElement(id: part.id, kind: .reasoning(t, live: false)))
                }
            case .tool(let t):
                run.append(t)
            }
        }
        if !run.isEmpty { flush() }
        if let i = thinkingIndex, m.isStreaming, case .reasoning? = m.parts.last, case .reasoning(let t, _) = out[i].kind {
            out[i] = BodyElement(id: out[i].id, kind: .reasoning(t, live: true))
        }
        return out
    }

    @ViewBuilder private func elementView(_ el: BodyElement, message m: ChatMessage, store: ChatStore) -> some View {
        switch el.kind {
        case .text(let text):
            AssistantTextView(text: text)
        case .reasoning(let text, let live):
            ThinkingBlock(text: text, startedAt: m.reasoningStartedAt, endedAt: m.reasoningEndedAt, isStreaming: live)
        case .tools(let tools):
            ToolGroupCard(tools: tools, inspectedId: sizeClass == .regular ? selectedTool?.id : nil) { tool in
                if sizeClass == .regular { withAnimation { model.splitColumns = .detailOnly } }
                selectedTool = tool
            }
        case .plan(let tool):
            PlanCard(
                tool: tool,
                modelName: m.model,
                timestamp: m.timestamp,
                canImplement: store.latestPlanToolId == tool.id,
                onImplement: {
                    Task { try? await store.send("Implement the plan", model: modelId, agentId: "exec", thinking: thinking) }
                }
            )
        }
    }

    /// Footer only under the last assistant message of a turn, once it has finished streaming.
    private func showFooter(_ m: ChatMessage, in messages: [ChatMessage]) -> Bool {
        guard m.role == .assistant, !m.isStreaming, !m.parts.isEmpty else { return false }
        guard let i = messages.firstIndex(where: { $0.id == m.id }) else { return false }
        return i == messages.count - 1 || messages[i + 1].role == .user
    }

    @ViewBuilder private func bottomArea(_ store: ChatStore) -> some View {
        VStack(spacing: 10) {
            if store.todos.contains(where: { $0.status != "completed" }) {
                TodoPill(todos: store.todos, isStreaming: store.isStreaming)
                    .padding(.horizontal, 12)
            }
            if let question = store.pendingQuestion {
                QuestionCard(question: question) { answers in
                    Task { try? await store.answer(question, answers: answers) }
                }
            } else {
                Composer(
                    text: $draft,
                    agent: $agent,
                    modelId: $modelId,
                    thinking: $thinking,
                    placeholder: store.isStreaming ? "Queue a follow-up" : "Message \(workspace?.displayName ?? "agent")",
                    isStreaming: store.isStreaming,
                    contextFraction: store.contextTokens.map { min(1, Double($0) / 200_000) },
                    onSend: { send(store) },
                    onStop: { Task { try? await store.interrupt() } }
                )
            }
        }
        .padding(.horizontal, 12)
        .padding(.top, 4)
        .padding(.bottom, 8)
    }

    private func banner(_ text: String, tint: Color, icon: String) -> some View {
        HStack(spacing: 8) {
            Image(systemName: icon).font(.system(size: 12))
            Text(text).font(.system(size: 13)).lineLimit(2)
        }
        .foregroundStyle(tint)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .background(tint.opacity(0.12), in: RoundedRectangle(cornerRadius: 12))
        .padding(.horizontal, 16)
        .padding(.top, 8)
    }

    // MARK: - Actions

    private func send(_ store: ChatStore) {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        draft = ""
        Task { try? await store.send(text, model: modelId, agentId: agent, thinking: thinking) }
    }

    // MARK: - Toolbar

    @ToolbarContentBuilder private var toolbarContent: some ToolbarContent {
        ToolbarItem(placement: .principal) {
            VStack(spacing: 1) {
                Text(workspace?.displayName ?? workspaceId)
                    .font(.xMono(15, weight: .semibold))
                    .foregroundStyle(Color.xText)
                    .lineLimit(1)
                subtitle
            }
        }
        ToolbarItem(placement: .topBarTrailing) {
            HStack(spacing: 2) {
                Button { } label: {
                    Image(systemName: "terminal")
                        .font(.system(size: 14))
                        .frame(width: 32, height: 32)
                        .contentShape(Rectangle())
                }
                .foregroundStyle(Color.xText2)
                .disabled(true)
                .accessibilityLabel("Terminal")
                Menu {
                    Button("Copy workspace name") {
                        UIPasteboard.general.string = workspace?.displayName ?? workspaceId
                    }
                    Button("Refresh") {
                        store?.stop()
                        store?.start()
                    }
                } label: {
                    Image(systemName: "ellipsis")
                        .font(.system(size: 14, weight: .semibold))
                        .frame(width: 32, height: 32)
                        .contentShape(Rectangle())
                }
                .foregroundStyle(Color.xText)
                .accessibilityLabel("More")
            }

        }
    }

    /// `projectName · runtime · serverName`, with the `ssh` runtime word in `xSsh`.
    private var subtitle: some View {
        let ws = workspace
        let runtime = ws?.runtime ?? .local
        let base = Color.xText2
        return HStack(spacing: 0) {
            Text("\(ws?.projectName ?? "") · ").foregroundStyle(base)
            Text(runtime.label.lowercased()).foregroundStyle(runtime == .ssh ? Color.xSsh : base)
            Text(" · \(serverName)").foregroundStyle(base)
        }
        .font(.system(size: 12))
        .lineLimit(1)
    }
}
