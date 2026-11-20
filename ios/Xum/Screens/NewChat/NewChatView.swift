import SwiftUI

/// New chat sheet (docs/03 §12, `NewA.dc.html`): project switcher, START FROM group, runtime and
/// trunk chips, and a small local composer (the chat composer lives in Chat/, another agent's area).
struct NewChatView: View {
    var projectPath: String?

    @Environment(AppModel.self) private var model
    @State private var selectedProject: Project?
    @State private var startFrom: StartFrom = .workspace
    @State private var runtime: RuntimeKind = .worktree
    @State private var trunk = "main"
    @State private var branches: [String] = ["main"]
    @State private var message = ""
    @State private var agentId = "exec"
    /// The user's pick; until then the sheet follows the current server's default, which can
    /// change after the sheet opens (the server's catalog is still loading, or the server changed).
    @State private var pickedModel: String?
    @State private var thinking: ThinkingLevel = .medium
    @State private var sending = false
    @State private var error: String?

    enum StartFrom: Hashable { case workspace, scratch, fork }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        projectSwitcher
                        startFromGroup
                    }
                    .padding(.horizontal, 16)
                    .padding(.top, 12)
                }
                .scrollEdgeEffectStyle(.soft, for: .bottom)
                VStack(spacing: 8) {
                    if let error {
                        Text(error)
                            .font(.system(size: 13))
                            .foregroundStyle(Color.xBad)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 12)
                    }
                    setupChips
                    composer
                }
                .padding(.horizontal, 12)
                .padding(.bottom, 8)
            }
            .background(Color.xBg2.ignoresSafeArea())
            .navigationTitle("New Chat")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button {
                        model.sheet = nil
                    } label: {
                        Image(systemName: "xmark").foregroundStyle(Color.xText)
                    }
                    .accessibilityLabel("Close")
                }
            }
        }
        .presentationDetents([.large])
        .onAppear {
            if agentId.isEmpty { agentId = model.defaultAgent }
            thinking = model.defaultThinking
            if selectedProject == nil {
                let projects = model.list?.projects ?? []
                selectedProject = projects.first { $0.path == projectPath } ?? projects.first
            }
            if let p = selectedProject { Task { await loadBranches(p.path) } }
        }
    }

    // MARK: Project switcher

    private var projectSwitcher: some View {
        Menu {
            ForEach(model.list?.projects ?? []) { p in
                Button {
                    selectedProject = p
                    // Fork needs a source in the new project; fall back to a new workspace.
                    if startFrom == .fork, mostRecentWorkspace == nil { startFrom = .workspace }
                    Task { await loadBranches(p.path) }
                } label: {
                    if p.id == selectedProject?.id { Label(p.name, systemImage: "checkmark") } else { Text(p.name) }
                }
            }
        } label: {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(selectedProject?.name ?? "xum")
                        .font(.xTitle)
                        .foregroundStyle(Color.xText)
                    Image(systemName: "chevron.down")
                        .font(.system(size: 17, weight: .semibold))
                        .foregroundStyle(Color.xText2)
                }
                Text(projectCaption)
                    .font(.xMono(13))
                    .lineLimit(1).truncationMode(.middle)
                    .foregroundStyle(Color.xText2)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.leading, 4)
            .padding(.top, 4)
            .contentShape(Rectangle())
        }
    }

    /// `~/src/xum · devbox`: home dir abbreviated, then the server name.
    private var projectCaption: String {
        let path = selectedProject?.path ?? ""
        // The path is on the server, so abbreviate its home directory, not the phone's.
        let short = path.replacingOccurrences(of: #"^/(Users|home)/[^/]+"#, with: "~", options: .regularExpression)
        var parts: [String] = []
        if !short.isEmpty { parts.append(short) }
        if let server = model.servers.current?.name, !server.isEmpty { parts.append(server) }
        return parts.joined(separator: " · ")
    }

    // MARK: Start from

    private var startFromGroup: some View {
        VStack(alignment: .leading, spacing: 0) {
            SectionCaption(text: "Start from")
                .padding(.leading, 16)
                .padding(.top, 26)
                .padding(.bottom, 8)
            VStack(spacing: 0) {
                startRow(kind: .workspace, tile: Color.xAccentFill, icon: "folder") {
                    HStack(spacing: 0) {
                        Text("New workspace").font(.system(size: 16)).foregroundStyle(Color.xText)
                    }
                } trailing: {
                    if startFrom == .workspace {
                        Image(systemName: "checkmark").font(.system(size: 14, weight: .semibold)).foregroundStyle(Color.xAccent)
                    }
                }
                separator
                startRow(kind: .scratch, tile: NewChatTile.slate, icon: "message") {
                    Text("Scratch chat, no checkout").font(.system(size: 16)).foregroundStyle(Color.xText)
                } trailing: {
                    if startFrom == .scratch {
                        Image(systemName: "checkmark").font(.system(size: 14, weight: .semibold)).foregroundStyle(Color.xAccent)
                    }
                }
                separator
                startRow(kind: mostRecentWorkspace == nil ? nil : .fork, tile: NewChatTile.forkBlue, icon: "arrow.triangle.branch") {
                    HStack(spacing: 5) {
                        Text("Fork").font(.system(size: 16)).foregroundStyle(Color.xText)
                        if let name = mostRecentWorkspaceName {
                            Text(name).font(.xMono(14.5, weight: .medium)).foregroundStyle(Color.xText)
                                .lineLimit(1).truncationMode(.middle)
                        }
                    }
                } trailing: {
                    if startFrom == .fork {
                        Image(systemName: "checkmark").font(.system(size: 14, weight: .semibold)).foregroundStyle(Color.xAccent)
                    }
                }
                separator
                startRow(kind: nil, tile: NewChatTile.rust, icon: "cpu") {
                    HStack(spacing: 5) {
                        Text("/orchestrate").font(.xMono(14.5, weight: .medium)).foregroundStyle(Color.xText)
                        Text("across sub-agents").font(.system(size: 16)).foregroundStyle(Color.xText)
                    }
                } trailing: { EmptyView() }
                .disabled(true)
                .opacity(0.55)
            }
            .background(RoundedRectangle(cornerRadius: 26, style: .continuous).fill(Color.xCell))
        }
    }

    private var separator: some View {
        Rectangle().fill(Color.xSep).frame(height: 0.5).padding(.leading, 58)
    }

    private func startRow<Label: View, Trailing: View>(kind: StartFrom?, tile: Color, icon: String,
                                                       @ViewBuilder label: () -> Label,
                                                       @ViewBuilder trailing: () -> Trailing) -> some View {
        Button {
            if let kind { startFrom = kind }
        } label: {
            HStack(spacing: 12) {
                NewChatTileIcon(color: tile, systemImage: icon)
                label()
                Spacer(minLength: 8)
                trailing()
            }
            .padding(.horizontal, 16)
            .frame(minHeight: 52)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    /// Newest checkout of the selected project, for the (disabled) Fork row.
    private var mostRecentWorkspaceName: String? { mostRecentWorkspace?.displayName }

    private var mostRecentWorkspace: Workspace? {
        guard let list = model.list, let path = selectedProject?.path else { return nil }
        return list.workspaces
            .filter { $0.projectPath == path && !$0.isScratch && $0.parentWorkspaceId == nil }
            .max { (list.activity[$0.id]?.recency ?? $0.createdAt ?? .distantPast) < (list.activity[$1.id]?.recency ?? $1.createdAt ?? .distantPast) }
    }

    // MARK: Setup chips

    private var setupChips: some View {
        HStack(spacing: 8) {
            Menu {
                ForEach([RuntimeKind.worktree, .local], id: \.self) { r in
                    Button {
                        runtime = r
                    } label: {
                        if r == runtime { Label(r.label, systemImage: "checkmark") } else { Text(r.label) }
                    }
                }
            } label: {
                Chip {
                    HStack(spacing: 6) {
                        Image(systemName: "arrow.triangle.branch").font(.system(size: 12)).foregroundStyle(Color.xAccent)
                        Text(runtime.label).fixedSize()
                        Image(systemName: "chevron.down").font(.system(size: 11)).foregroundStyle(Color.xText2)
                    }
                }
            }
            Menu {
                ForEach(branches, id: \.self) { b in
                    Button {
                        trunk = b
                    } label: {
                        if b == trunk { Label(b, systemImage: "checkmark") } else { Text(b) }
                    }
                }
            } label: {
                Chip {
                    HStack(spacing: 6) {
                        Text("from").foregroundStyle(Color.xText2)
                        Text(trunk).font(.xMono(14, weight: .medium))
                        Image(systemName: "chevron.down").font(.system(size: 11)).foregroundStyle(Color.xText2)
                    }
                }
            }
            .disabled(branches.isEmpty)
            Chip {
                HStack(spacing: 6) {
                    Text("branch").foregroundStyle(Color.xText2)
                    Text("auto")
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 4)
    }

    // MARK: Composer

    private var composer: some View {
        VStack(spacing: 10) {
            TextField("Describe the task", text: $message, axis: .vertical)
                .font(.system(size: 16))
                .lineLimit(2...6)
                .padding(.horizontal, 8)
                .padding(.top, 4)
            HStack(spacing: 6) {
                agentChip
                modelChip
                thinkingChip
                Spacer(minLength: 0)
                sendButton
            }
        }
        .padding(12)
        .glassRect(30)
    }

    private var agentChip: some View {
        Menu {
            ForEach(["exec", "plan"], id: \.self) { id in
                Button {
                    agentId = id
                } label: {
                    if id == agentId { Label(Self.agentLabel(id), systemImage: "checkmark") } else { Text(Self.agentLabel(id)) }
                }
            }
        } label: {
            Chip(selected: agentId != model.defaultAgent) {
                HStack(spacing: 6) {
                    StatusDot(color: agentId == "plan" ? .xPlan : .xAccentFill, size: 7)
                    Text(Self.agentLabel(agentId)).foregroundStyle(Color.xAccent)
                }
            }
        }
    }

    private static func agentLabel(_ id: String) -> String {
        switch id {
        case "plan": "Plan"
        case "explore": "Explore"
        default: "Exec"
        }
    }

    private var modelChip: some View {
        Menu {
            ForEach(model.modelChoices, id: \.self) { id in
                Button {
                    pickedModel = id
                } label: {
                    if id == modelId { Label(ModelName.display(id), systemImage: "checkmark") } else { Text(ModelName.display(id)) }
                }
            }
        } label: {
            Chip {
                HStack(spacing: 6) {
                    Text(ModelName.display(modelId))
                    Image(systemName: "chevron.down").font(.system(size: 11)).foregroundStyle(Color.xText2)
                }
            }
        }
    }


    private var thinkingChip: some View {
        Menu {
            ForEach(ThinkingLevel.allCases, id: \.self) { level in
                Button {
                    thinking = level
                } label: {
                    if level == thinking { Label(level.label, systemImage: "checkmark") } else { Text(level.label) }
                }
            }
        } label: {
            Chip {
                Text(thinking.chip)
            }
        }
    }

    private var sendButton: some View {
        HStack(spacing: 14) {
        Image(systemName: "paperclip")
            .font(.system(size: 17))
            .foregroundStyle(Color.xText2)
            .accessibilityLabel("Attach")
        Button {
            Task { await send() }
        } label: {
            Image(systemName: "arrow.up")
                .font(.system(size: 15, weight: .bold))
                .foregroundStyle(canSend ? Color.white : Color.xText3)
                .frame(width: 36, height: 36)
                .background(Circle().fill(canSend ? Color.xAccentFill : Color.xFill))
        }
        .buttonStyle(.plain)
        .disabled(!canSend)
        .accessibilityLabel("Start")
        }
    }

    private var canSend: Bool {
        !message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !sending && !busy
    }

    /// A workspace start needs a project; scratch chats always work.
    private var busy: Bool {
        (startFrom == .workspace && selectedProject == nil) || (startFrom == .fork && mostRecentWorkspace == nil)
    }

    private var modelId: String {
        pickedModel.flatMap { model.modelChoices.contains($0) ? $0 : nil } ?? model.defaultModel
    }

    // MARK: Actions

    private func loadBranches(_ path: String) async {
        guard let client = model.servers.currentClient else { return }
        do {
            let res = try await client.call("projects/listBranches", ["projectPath": .string(path)])
            let loaded = (res["branches"]?.array ?? []).compactMap { b in b.string ?? b["name"]?.string }
            // The user picked another project while this ran; its own load sets the branches.
            guard selectedProject?.path == path, !loaded.isEmpty else { return }
            branches = loaded
            if let recommended = res["recommendedTrunk"]?.string, loaded.contains(recommended) {
                trunk = recommended
            } else if !loaded.contains(trunk) {
                trunk = loaded.first { $0 == "main" } ?? loaded[0]
            }
        } catch {
            // Leave the `main` fallback; the trunk menu just stays short.
        }
    }

    private func send() async {
        sending = true
        error = nil
        defer { sending = false }
        do {
            let id: String
            if startFrom == .fork {
                guard let source = mostRecentWorkspace else { return }
                id = try await model.fork(source.id, message: message, model: modelId, agentId: agentId, thinking: thinking)
            } else if startFrom == .scratch {
                id = try await model.createScratch(projectPath: selectedProject?.path, message: message,
                                                   model: modelId, agentId: agentId, thinking: thinking)
            } else {
                guard let project = selectedProject else { return }
                id = try await model.createWorkspace(projectPath: project.path, runtime: runtime, trunk: trunk,
                                                     message: message, model: modelId, agentId: agentId, thinking: thinking)
            }
            message = ""
            model.sheet = nil
            model.open(id)
        } catch {
            self.error = error.localizedDescription
        }
    }
}

/// Fixed tile colours from the mockups (docs/02 §2 "Fixed colours"); no matching token exists.
enum NewChatTile {
    static let slate = Color(uiColor: UIColor(hex: 0x2F2D33))
    static let forkBlue = Color(uiColor: UIColor(hex: 0x4893FC))
    static let rust = Color(uiColor: UIColor(hex: 0xA13000))
}

/// 30x30 rounded tile with a white icon, as used by the START FROM rows (docs/02 §5).
struct NewChatTileIcon: View {
    let color: Color
    let systemImage: String
    var size: CGFloat = 30
    var radius: CGFloat = 8

    var body: some View {
        Image(systemName: systemImage)
            .font(.system(size: size * 0.5, weight: .semibold))
            .foregroundStyle(.white)
            .frame(width: size, height: size)
            .background(RoundedRectangle(cornerRadius: radius, style: .continuous).fill(color))
    }
}
