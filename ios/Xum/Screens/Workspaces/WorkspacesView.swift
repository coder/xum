import SwiftUI

/// Workspaces tab root: one section per project (plus `Chats` for scratch chats), a filter and
/// New chat capsule, swipe-to-archive and pull to refresh.
struct WorkspacesView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.inSidebar) private var sidebar
    @State private var filter: WorkspaceFilter = .all
    /// An archive the server held back because it would lose untracked files (`confirm-lossy-untracked-files`).
    @State private var lossyArchive: (workspace: Workspace, confirmation: JSONValue)?

    var body: some View {
        Group {
            if let list = model.list {
                if list.loaded {
                    Group {
                        if list.sections.isEmpty { emptyView } else { listView(list) }
                    }
                    // A later refresh or archive failure keeps the loaded rows and says so.
                    .safeAreaInset(edge: .top, spacing: 0) {
                        if let err = list.error {
                            HStack(spacing: 8) {
                                Image(systemName: "exclamationmark.triangle").foregroundStyle(Color.xBad)
                                Text(err).font(.system(size: 13)).foregroundStyle(Color.xText).lineLimit(2)
                                Spacer(minLength: 0)
                                Button("Retry") { Task { await list.refresh() } }.font(.system(size: 13, weight: .semibold))
                            }
                            .padding(.horizontal, 16)
                            .padding(.vertical, 10)
                            .background(Color.xCell)
                        }
                    }
                } else if let err = list.error {
                    ContentUnavailableView {
                        Label("Can't reach \(model.servers.current?.name ?? "server")", systemImage: "wifi.exclamationmark")
                    } description: {
                        Text(err)
                    } actions: {
                        Button("Try Again") { Task { await list.refresh() } }.buttonStyle(.glass)
                        Button("Switch Server") { model.sheet = .servers }
                    }
                } else {
                    ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            } else if let server = model.servers.current {
                // The record exists but its token does not (see ServerStore.refreshReachability).
                ContentUnavailableView {
                    Label("Sign in to \(server.name) again", systemImage: "key")
                } description: {
                    Text("This iPhone has no token for this server. Paste its connection link to add one.")
                } actions: {
                    Button("Paste Link") { model.sheet = .connectLink(prefill: nil) }.buttonStyle(.glass)
                    Button("Switch Server") { model.sheet = .servers }
                }
            } else {
                ContentUnavailableView("No server", systemImage: "server.rack")
            }
        }
        .background(Color.xBg2.ignoresSafeArea())
        .navigationTitle("Workspaces")
        .navigationBarTitleDisplayMode(sidebar ? .large : .automatic)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) { ServerMenuButton() }
            ToolbarItemGroup(placement: .topBarTrailing) { trailingCapsule.foregroundStyle(Color.xText) }
        }
    }

    private var trailingCapsule: some View {
        Group {
            Menu {
                ForEach(WorkspaceFilter.allCases, id: \.self) { f in
                    Button {
                        filter = f
                    } label: {
                        if f == filter { Label(f.label, systemImage: "checkmark") } else { Text(f.label) }
                    }
                }
            } label: {
                Image(systemName: "line.3.horizontal.decrease")
            }
            .accessibilityLabel("Filter workspaces")
            Button {
                model.sheet = .newChat(projectPath: nil)
            } label: {
                Image(systemName: "plus")
            }
            .accessibilityLabel("New chat")
        }
    }

    private var emptyView: some View {
        ContentUnavailableView {
            Label("No workspaces", systemImage: "square.stack.3d.up")
        } description: {
            Text("Start a new chat to create one.")
        } actions: {
            Button("New Chat") { model.sheet = .newChat(projectPath: nil) }
                .buttonStyle(.borderedProminent)
        }
    }

    @ViewBuilder private func listView(_ list: WorkspaceListStore) -> some View {
        if sidebar { listBody(list).listStyle(.plain) } else { listBody(list).listStyle(.insetGrouped) }
    }

    private func listBody(_ list: WorkspaceListStore) -> some View {
        List {
            // The project path is unique where titles are not (shared display names, a project named
            // Chats); scratch chats have no path.
            ForEach(filteredSections(list), id: \.projectPath) { section in
                Section {
                    ForEach(Array(section.items.enumerated()), id: \.element.id) { i, w in
                        row(w, index: i, count: section.items.count, list: list)
                    }
                } header: {
                    SectionCaption(text: "\(section.title) · \(section.items.count)")
                        .textCase(nil)
                }
            }
        }
        .scrollContentBackground(.hidden)
        .refreshable { await list.refresh() }
        .confirmationDialog(lossyTitle, isPresented: Binding(get: { lossyArchive != nil }, set: { if !$0 { lossyArchive = nil } }),
                            titleVisibility: .visible, presenting: lossyArchive) { pending in
            Button("Archive and Lose Files", role: .destructive) {
                Task { await archive(pending.workspace, in: list, acknowledging: pending.confirmation) }
            }
            Button("Cancel", role: .cancel) {}
        } message: { pending in
            Text(Self.lossyMessage(pending.confirmation))
        }
    }

    private var lossyTitle: String { "Archive \(lossyArchive?.workspace.displayName ?? "workspace")?" }

    static func lossyMessage(_ c: JSONValue) -> String {
        let paths = (c["paths"]?.array ?? []).compactMap(\.string)
            + (c["subagents"]?.array ?? []).flatMap { ($0["paths"]?.array ?? []).compactMap(\.string) }
        let shown = paths.prefix(5).joined(separator: "\n")
        let more = paths.count > 5 ? "\nand \(paths.count - 5) more" : ""
        return "Archiving deletes \(paths.count) untracked \(paths.count == 1 ? "file" : "files") that git does not keep:\n\(shown)\(more)"
    }

    private func row(_ w: Workspace, index i: Int, count: Int, list: WorkspaceListStore) -> some View {
        let selected = sidebar && model.shownWorkspaceId == w.id
        return WorkspaceRow(
            workspace: w,
            activity: list.activity[w.id],
            attention: list.attention[w.id],
            isFirst: i == 0,
            isLast: i == count - 1,
            selected: selected,
            diff: list.diffStats[w.id],
            sidebar: sidebar
        )
        .onTapGesture { model.open(w.id) }
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            Button(role: .destructive) {
                Task { await archive(w, in: list) }
            } label: {
                Label("Archive", systemImage: "archivebox")
            }
        }
    }

    private func filteredSections(_ list: WorkspaceListStore) -> [(title: String, projectPath: String?, items: [Workspace])] {
        list.sections.compactMap { section in
            let items = section.items.filter { filter.matches($0, activity: list.activity, attention: list.attention) }
            guard !items.isEmpty else { return nil }
            return (title: section.title, projectPath: section.projectPath, items: items)
        }
    }

    private func archive(_ w: Workspace, in list: WorkspaceListStore, acknowledging confirmation: JSONValue? = nil) async {
        guard let client = model.servers.currentClient else { return }
        var body: [String: JSONValue] = ["workspaceId": .string(w.id)]
        if let confirmation {
            body["acknowledgedUntrackedPaths"] = confirmation["paths"] ?? []
            var bySubagent: [String: JSONValue] = [:]
            for sub in confirmation["subagents"]?.array ?? [] {
                if let id = sub["workspaceId"]?.string { bySubagent[id] = sub["paths"] ?? [] }
            }
            if !bySubagent.isEmpty { body["acknowledgedSubagentUntrackedPaths"] = .object(bySubagent) }
        }
        do {
            let r = try await client.call("workspace/archive", .object(body))
            if r["data"]?["kind"]?.string == "confirm-lossy-untracked-files", let data = r["data"] {
                lossyArchive = (w, data)
                return
            }
            await list.refresh()
        } catch {
            list.error = error.localizedDescription
        }
    }
}

extension Attention {
    /// Questions, plans and approvals mean the agent stopped for the user; error rows are
    /// failures, not waits.
    var isWaiting: Bool {
        switch self {
        case .question, .planReady, .approval: true
        case .error: false
        }
    }
}

enum WorkspaceFilter: CaseIterable, Hashable {
    case all, running, waitingOnYou

    var label: String {
        switch self {
        case .all: "All"
        case .running: "Running"
        case .waitingOnYou: "Waiting on you"
        }
    }

    func matches(_ w: Workspace, activity: [String: WorkspaceActivity], attention: [String: Attention]) -> Bool {
        switch self {
        case .all: true
        case .running: activity[w.id]?.streaming == true
        case .waitingOnYou: attention[w.id]?.isWaiting == true
        }
    }
}

/// 20 pt leading status icon (docs/02 §6): running, waiting, failed, done or idle.
struct StatusIcon: View {
    let streaming: Bool
    let attention: Attention?
    let todosDone: Bool
    var scratch = false

    var body: some View {
        Group {
            if streaming {
                Image(systemName: "arrow.triangle.2.circlepath")
                    .foregroundStyle(Color.xAccent)
                    .symbolEffect(.rotate, options: .repeating)
            } else if let attention {
                switch attention {
                case .question, .planReady, .approval:
                    Image(systemName: "exclamationmark.circle").foregroundStyle(Color.xWarn)
                case .error:
                    Image(systemName: "xmark.circle").foregroundStyle(Color.xBad)
                }
            } else if todosDone {
                Image(systemName: "checkmark").foregroundStyle(Color.xOk)
            } else if scratch {
                Image(systemName: "bubble.left").foregroundStyle(Color.xText2)
            } else {
                Image(systemName: "circle").foregroundStyle(Color.xText3)
            }
        }
        .font(.system(size: 20))
        .frame(width: 20, height: 20)
    }
}

/// One workspace row: status icon, mono branch name, status line, trailing time (+ accent dot
/// when waiting). First/last rows round the section's `xCell` card.
struct WorkspaceRow: View {
    let workspace: Workspace
    let activity: WorkspaceActivity?
    let attention: Attention?
    let isFirst: Bool
    let isLast: Bool
    let selected: Bool
    var diff: (added: Int, removed: Int)?
    var sidebar = false

    private var waiting: Bool { attention?.isWaiting ?? false }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                StatusIcon(
                    streaming: activity?.streaming == true,
                    attention: attention,
                    todosDone: ["✅", "✓", "✔️"].contains(activity?.statusLine?.emoji ?? ""),
                    scratch: workspace.isScratch
                )
                VStack(alignment: .leading, spacing: 2) {
                    Text(workspace.displayName)
                        .font(workspace.isScratch ? .system(size: 16) : .xMono(15, weight: waiting ? .bold : .medium))
                        .foregroundStyle(selected ? Color.xAccent : Color.xText)
                        .lineLimit(1)
                    statusLine
                }
                Spacer(minLength: 8)
                VStack(alignment: .trailing, spacing: 3) {
                    Text(RelativeTime.short(activity?.recency ?? workspace.createdAt))
                        .font(.system(size: 13))
                        .foregroundStyle(Color.xText3)
                    if waiting {
                        StatusDot(color: .xAccent)
                    } else if let diff, diff.added + diff.removed > 0 {
                        HStack(spacing: 4) {
                            Text("+\(diff.added)").foregroundStyle(Color.xOk)
                            Text("−\(diff.removed)").foregroundStyle(Color.xBad)
                        }
                        .font(.xMono(12, weight: .medium))
                    }
                }
            }
            .padding(.horizontal, sidebar ? 12 : 16)
            .frame(minHeight: sidebar ? 52 : (workspace.isScratch ? 60 : 70))
        }
        .listRowInsets(sidebar ? EdgeInsets(top: 0, leading: 8, bottom: 0, trailing: 8) : EdgeInsets())
        .listRowSeparator(sidebar ? .hidden : .automatic)
        .listRowBackground(background)
    }

    @ViewBuilder private var background: some View {
        if sidebar {
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(selected ? Color.xAccentSoft : .clear)
                .padding(.horizontal, 8)
        } else {
            ZStack { Color.xCell; if selected { Color.xAccentSoft } }
        }
    }

    private var shape: some Shape {
        UnevenRoundedRectangle(
            topLeadingRadius: isFirst ? 26 : 0,
            bottomLeadingRadius: isLast ? 26 : 0,
            bottomTrailingRadius: isLast ? 26 : 0,
            topTrailingRadius: isFirst ? 26 : 0,
            style: .continuous
        )
    }

    @ViewBuilder
    private var statusLine: some View {
        HStack(spacing: 0) {
            if let prefix {
                Text(prefix).foregroundStyle(Color.xSsh)
            }
            if let attention {
                Text(attention.line)
                    .foregroundStyle(attention.isWaiting ? Color.xWarn : Color.xBad)
            } else if let message = activity?.statusLine?.message {
                Text(message).foregroundStyle(Color.xText2)
            } else {
                Text("Idle").foregroundStyle(Color.xText2)
            }
        }
        .font(.system(size: 14))
        .lineLimit(1)
    }

    /// `ssh · ` for remote runtimes, in the runtime blue (docs/03 §6).
    private var prefix: String? {
        switch workspace.runtime {
        case .ssh: "ssh · "
        case .docker: "docker · "
        case .coder: "coder · "
        default: nil
        }
    }
}
