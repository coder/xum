import SwiftUI
import UIKit

/// Chat for one workspace: message list, tool groups, plan and question cards, composer.
struct ChatView: View {
    let workspaceId: String

    @Environment(AppModel.self) private var model
    @Environment(\.horizontalSizeClass) private var sizeClass
    @Environment(\.scenePhase) private var scenePhase
    @State private var store: ChatStore?
    @State private var agent = "exec"
    /// The user's pick or the agent's saved model. The composer follows the current server's
    /// default until there is one the server offers: its catalog can still be loading.
    @State private var pickedModel: String?
    private var modelId: String {
        pickedModel.flatMap { model.modelChoices.contains($0) ? $0 : nil } ?? model.defaultModel
    }
    @State private var thinking: ThinkingLevel = .medium
    /// The user picked an agent, model or thinking level here: the workspace's saved settings
    /// no longer replace the composer's.
    @State private var settingsEdited = false
    /// The inspected call is looked up in the store on each render, so a call that is still
    /// running keeps its output and state current in the open inspector.
    @State private var selectedToolId: String?
    private var selectedTool: ToolCall? {
        guard let id = selectedToolId else { return nil }
        for m in store?.messages.reversed() ?? [] { if let t = m.tools.first(where: { $0.id == id }) { return t } }
        return nil
    }
    private var selectedToolBinding: Binding<ToolCall?> {
        Binding(get: { selectedTool }, set: { selectedToolId = $0?.id })
    }
    @State private var seeded = false
    @State private var scrollPosition = ScrollPosition(edge: .bottom)
    @State private var followBottom = true
    @State private var lastAtBottom = true
    @State private var userScrolling = false
    @State private var showInfo = false
    @State private var info: WorkspaceInfoStore?
    /// The plan file's text for the latest plan (keyed by its tool call ID).
    @State private var planFile: (toolId: String, content: String)?
    /// Implement was tapped and its send is not yet accepted: a second tap would queue it twice.
    @State private var implementing = false

    private var workspace: Workspace? { model.list?.workspace(workspaceId) }
    private var pendingQuestion: PendingQuestion? { store?.pendingQuestion }
    private var serverName: String { model.servers.current?.name ?? "" }

    var body: some View {
        HStack(spacing: 0) {
            Group {
                if let store {
                    chat(store)
                } else {
                    Color.xBg
                }
            }
            .background { Color.xBg.ignoresSafeArea() }
            if sizeClass == .regular, showInfo || selectedTool != nil || pendingQuestion != nil { sidePanel }
        }
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { toolbarContent }
        .toolbar(.hidden, for: .tabBar)
        .onAppear(perform: attach)
        // Reload on return to the app too: the plan file may have been edited elsewhere.
        .task(id: "\(store?.latestPlanToolId ?? "")|\(scenePhase == .active)") { await loadPlanFile() }
        // The server hands back a queued message it did not run (Stop, a refused send): put it
        // back in the composer, then let the server drop its held copy.
        .onChange(of: store?.restoredInput?.seq) { takeRestoredInput() }
        .onChange(of: model.unsentFirstMessages[workspaceId] != nil) { takeUnsentFirstMessage() }
        // A chat opened right after create or fork gets its metadata later, and the first send
        // saves its agent and settings after that.
        .onChange(of: savedSettings) { if !settingsEdited { seedSettings() } }
        // Opening a chat does not answer it: rescan so a question or plan stays in the Inbox.
        .onDisappear { if let list = model.list { Task { await list.scan(workspaceId) } } }
        // Regular width (iPhone Duo inner display): the tool detail is a persistent side panel
        // beside the chat instead of a modal sheet; tapping another row swaps its content.
        .sheet(item: sizeClass == .regular ? .constant(nil) : selectedToolBinding) { tool in
            ToolDetailSheet(tool: tool) { prefill in
                store?.draft.setText(prefill)
            }
        }
        .sheet(isPresented: sizeClass == .regular ? .constant(false) : $showInfo) {
            if let info {
                WorkspaceInfoView(store: info, chat: store) { showInfo = false }
                    .presentationDetents([.medium, .large])
                    .presentationBackground(Color.xBg2)
            }
        }
        .task(id: pendingQuestion?.toolCallId) {
            if sizeClass == .regular, pendingQuestion != nil { withAnimation { model.splitColumns = .detailOnly } }
        }
    }

    /// A plain column rather than `.inspector`: an open inspector turns into a sheet when the
    /// Duo folds, and that sheet stayed on the outer display, empty, after the split view went away.
    @ViewBuilder private var sidePanel: some View {
        Group {
            // A pending question takes the panel (read the plan while answering); a tapped tool
            // row replaces it until the panel is closed.
            if showInfo, let info {
                WorkspaceInfoView(store: info, chat: store) { withAnimation { showInfo = false } }
            } else if let tool = selectedTool {
                ToolDetailSheet(tool: tool, onAsk: { store?.draft.setText($0) }, onClose: { selectedToolId = nil })
                    .id(tool.id)
            } else if let question = pendingQuestion, let store {
                QuestionCard(question: question, panel: true) { answers in
                    Task { try? await store.answer(question, answers: answers, options: sendOptions) }
                }
                .id(question.toolCallId)
                .padding(.top, 8)
            }
        }
        .frame(width: 410)
        .frame(maxHeight: .infinity)
        .background { Color.xBg2.ignoresSafeArea() }
        .transition(.move(edge: .trailing))
    }

    // MARK: - Setup

    private func takeRestoredInput() {
        guard let store, let r = store.takeRestoredInput(), !r.text.isEmpty else { return }
        restoreToComposer(r.text)
        if r.textOnly { Task { await store.discardHeld(r.heldInputIds) } }
    }

    private func restoreToComposer(_ text: String) {
        store?.draft.restore(text)
    }

    /// The first send runs after the chat opens, so its failure can arrive while it is shown. Its
    /// text is back in this workspace's draft, or, when that write was not confirmed, comes back
    /// here (AppModel.startFirstSend).
    private func takeUnsentFirstMessage() {
        guard let store, let unsent = model.takeUnsentFirstMessage(workspaceId) else { return }
        if let text = unsent.text, !store.draft.text.contains(text) { restoreToComposer(text) }
        store.report("The first message did not send: \(unsent.reason)")
    }

    private func attach() {
        guard !seeded else { return }
        seeded = true
        store = model.chatStore(workspaceId)
        takeUnsentFirstMessage()
        info = model.servers.currentClient.map { WorkspaceInfoStore(workspaceId: workspaceId, client: $0) }
        info?.projectPath = workspace?.projectPath
        seedSettings()
    }

    private func loadPlanFile() async {
        guard scenePhase == .active, let toolId = store?.latestPlanToolId, let c = model.servers.currentClient else { return }
        guard let r = try? await c.call("workspace/getPlanContent", ["workspaceId": .string(workspaceId)]),
              let content = r["data"]?["content"]?.string, store?.latestPlanToolId == toolId else { return }
        planFile = (toolId, content)
    }

    private var savedSettings: [JSONValue?] { [workspace?.raw["agentId"], workspace?.raw["aiSettingsByAgent"]] }

    /// Agent/model/thinking start from the workspace's last selected agent (metadata `agentId`)
    /// and its saved per-agent settings, then app defaults.
    private func seedSettings() {
        let saved = workspace?.raw["agentId"]?.string.flatMap { AgentOption.selectable.contains($0) ? $0 : nil }
        applySettings(for: saved ?? model.defaultAgent)
    }

    private func applySettings(for agentId: String) {
        func setting(_ key: String) -> String? {
            workspace?.raw["aiSettingsByAgent"]?[agentId]?[key]?.string
        }
        agent = agentId
        pickedModel = setting("model")
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
            if store.autoCompacting {
                banner("Compacting the conversation to free up context", tint: .xAccent, icon: "arrow.down.right.and.arrow.up.left")
            }
            if let connection = store.connectionError {
                banner(connection, tint: .xWarn, icon: "wifi.exclamationmark")
            }
            messages(store)
        }
        .safeAreaInset(edge: .bottom, spacing: 0) { bottomArea(store) }
    }

    /// Following the stream: while the user is at the bottom, content growth keeps the bottom
    /// edge in place (the `.sizeChanges` anchor), with no animated scroll per delta. Scrolling up
    /// stops following; only the user's own scroll gestures change that, never content growth.
    private func messages(_ store: ChatStore) -> some View {
        ZStack {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 14) {
                    if store.hasOlder {
                        LoadOlderButton(loading: store.loadingOlder) { loadOlder(store) }
                    }
                    ForEach(store.messages) { message in
                        messageRow(message, store: store)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.top, 8)
                .padding(.bottom, 8)
            }
            .scrollPosition($scrollPosition)
            .defaultScrollAnchor(.bottom)
            .defaultScrollAnchor(followBottom ? .bottom : .top, for: .sizeChanges)
            .onScrollGeometryChange(for: Bool.self) { geo in
                geo.contentOffset.y + geo.containerSize.height >= geo.contentSize.height - 48
            } action: { _, atBottom in
                lastAtBottom = atBottom
                if userScrolling { followBottom = atBottom }
            }
            .onScrollPhaseChange { _, phase in
                userScrolling = phase == .interacting || phase == .decelerating
                if phase == .idle { followBottom = lastAtBottom }
            }
            .onChange(of: store.messages.last(where: { $0.role == .user })?.id) { _, _ in
                // The user's own new message always brings the stream back into view.
                followBottom = true
                scrollPosition.scrollTo(edge: .bottom)
            }
            // Replaying a long transcript lays out in several passes; showing it only once the
            // server has caught up avoids watching the list jump to the bottom.
            .opacity(store.caughtUp ? 1 : 0)
            if !store.caughtUp {
                ProgressView().controlSize(.regular)
            }
        }
    }

    private func loadOlder(_ store: ChatStore) {
        followBottom = false
        Task { await store.loadOlder() }
    }

    @ViewBuilder private func messageRow(_ m: ChatMessage, store: ChatStore) -> some View {
        if case .request(let command)? = m.compaction {
            CompactionRequestMarker(command: command)
        } else if case .summary(let source)? = m.compaction {
            CompactionCard(message: m, source: source)
        } else if m.role == .user {
            VStack(spacing: 6) {
                if !m.text.isEmpty { UserBubble(text: m.text) }
                ForEach(Array(m.files.enumerated()), id: \.offset) { _, f in AttachmentChip(file: f) }
            }
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
                showInfo = false
                selectedToolId = tool.id
            }
        case .plan(let tool):
            PlanCard(
                tool: tool,
                modelName: m.model,
                timestamp: m.timestamp,
                canImplement: store.latestPlanToolId == tool.id && !implementing,
                fileContent: planFile?.toolId == tool.id ? planFile?.content : nil,
                onImplement: {
                    // The composer moves to Exec with it, so the next message does not go back to Plan.
                    settingsEdited = true
                    applySettings(for: "exec")
                    implementing = true
                    let file = planFile?.toolId == tool.id ? planFile?.content : nil
                    Task {
                        defer { implementing = false }
                        try? await store.implement(plan: tool, planFile: file, options: sendOptions)
                    }
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
            ForEach(store.heldInputs, id: \.id) { held in
                HeldInputRow(held: held) {
                    Task { await store.sendHeld(held.id) }
                } onDiscard: {
                    Task { await store.discardHeld([held.id]) }
                }
            }
            if let approval = store.openApproval {
                SandboxApprovalCard(approval: approval) { approved in
                    Task { try? await store.answerSandbox(approval, approved: approved) }
                }
                .id(approval.toolCallId)
            } else if let question = store.pendingQuestion, sizeClass != .regular {
                QuestionCard(question: question) { answers in
                    Task { try? await store.answer(question, answers: answers, options: sendOptions) }
                }
                // A new call gets fresh state: the old page index could be out of its range.
                .id(question.toolCallId)
            } else {
                Composer(
                    text: Binding(get: { store.draft.text }, set: { store.draft.setText($0) }),
                    // Each agent has its own saved model and thinking, as Implement applies them.
                    agent: Binding(get: { agent }, set: { if $0 != agent { settingsEdited = true; applySettings(for: $0) } }),
                    modelId: Binding(get: { modelId }, set: { settingsEdited = true; pickedModel = $0 }),
                    thinking: Binding(get: { thinking }, set: { settingsEdited = true; thinking = $0 }),
                    placeholder: store.isStreaming ? "Queue a follow-up" : "Message \(workspace?.displayName ?? "agent")",
                    isStreaming: store.isStreaming,
                    contextFraction: store.contextTokens.map { min(1, Double($0) / Double(ModelName.contextWindow(store.lastModel ?? modelId))) },
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

    /// The composer's send options (the web's getSendOptionsFromStorage), for sends that are not
    /// typed: question answers, Implement, resumes.
    private var sendOptions: [String: JSONValue] {
        ["model": .string(modelId), "agentId": .string(agent), "thinkingLevel": .string(thinking.rawValue)]
    }

    private func send(_ store: ChatStore) {
        let text = store.draft.text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        // The draft takes the text out of the composer and puts it back if it was not sent.
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
                Button {
                    withAnimation {
                        if sizeClass == .regular, !showInfo { model.splitColumns = .detailOnly }
                        showInfo.toggle()
                    }
                } label: {
                    Image(systemName: "sidebar.right")
                        .font(.system(size: 14))
                        .frame(width: 32, height: 32)
                        .contentShape(Rectangle())
                }
                .foregroundStyle(showInfo ? Color.xAccent : Color.xText)
                .accessibilityLabel("Workspace info")
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
