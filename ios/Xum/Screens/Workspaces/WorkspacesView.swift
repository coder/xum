import SwiftUI

/// Workspaces tab root: one section per project (plus `Chats` for scratch chats), a filter and
/// New chat capsule, swipe-to-archive and pull to refresh.
struct WorkspacesView: View {
    @Environment(AppModel.self) private var model
    @State private var filter: WorkspaceFilter = .all

    var body: some View {
        Group {
            if let list = model.list {
                if list.loaded {
                    if list.sections.isEmpty { emptyView } else { listView(list) }
                } else {
                    ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            } else {
                ContentUnavailableView("No server", systemImage: "server.rack")
            }
        }
        .background(Color.xBg2.ignoresSafeArea())
        .navigationTitle("Workspaces")
        .toolbar {
            ToolbarItem(placement: .topBarLeading) { ServerMenuButton() }
            ToolbarItem(placement: .topBarTrailing) { trailingCapsule }
        }
    }

    private var trailingCapsule: some View {
        HStack(spacing: 0) {
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
                    .frame(width: 42, height: 44)
                    .contentShape(Rectangle())
            }
            .accessibilityLabel("Filter workspaces")
            Button {
                model.sheet = .newChat(projectPath: nil)
            } label: {
                Image(systemName: "square.and.pencil")
                    .frame(width: 42, height: 44)
                    .contentShape(Rectangle())
            }
            .accessibilityLabel("New chat")
        }
        .glassCapsule()
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

    private func listView(_ list: WorkspaceListStore) -> some View {
        List {
            ForEach(filteredSections(list), id: \.title) { section in
                Section {
                    ForEach(Array(section.items.enumerated()), id: \.element.id) { i, w in
                        let row = WorkspaceRow(
                            workspace: w,
                            activity: list.activity[w.id],
                            attention: list.attention[w.id],
                            isFirst: i == 0,
                            isLast: i == section.items.count - 1,
                            selected: model.selectedWorkspaceId == w.id
                        )
                        row
                            .onTapGesture { model.open(w.id) }
                            .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                                Button(role: .destructive) {
                                    Task { await archive(w, in: list) }
                                } label: {
                                    Label("Archive", systemImage: "archivebox")
                                }
                            }
                    }
                } header: {
                    SectionCaption(text: "\(section.title) · \(section.items.count)")
                        .padding(.leading, 20)
                        .textCase(nil)
                }
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .refreshable { await list.refresh() }
    }

    private func filteredSections(_ list: WorkspaceListStore) -> [(title: String, projectPath: String?, items: [Workspace])] {
        list.sections.compactMap { section in
            let items = section.items.filter { filter.matches($0, activity: list.activity, attention: list.attention) }
            guard !items.isEmpty else { return nil }
            return (title: section.title, projectPath: section.projectPath, items: items)
        }
    }

    private func archive(_ w: Workspace, in list: WorkspaceListStore) async {
        guard let client = model.servers.currentClient else { return }
        do {
            try await client.call("workspace/archive", ["workspaceId": .string(w.id)])
            await list.refresh()
        } catch {
            list.error = error.localizedDescription
        }
    }
}

extension Attention {
    /// Question and plan mean the agent stopped for the user; error rows are failures, not waits.
    var isWaiting: Bool {
        switch self {
        case .question, .planReady: true
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

    var body: some View {
        Group {
            if streaming {
                Image(systemName: "circle.dotted")
                    .foregroundStyle(Color.xAccent)
                    .symbolEffect(.variableColor.iterative, options: .repeating)
            } else if let attention {
                switch attention {
                case .question, .planReady:
                    Image(systemName: "exclamationmark.circle.fill").foregroundStyle(Color.xWarn)
                case .error:
                    Image(systemName: "xmark.octagon.fill").foregroundStyle(Color.xBad)
                }
            } else if todosDone {
                Image(systemName: "checkmark.circle.fill").foregroundStyle(Color.xOk)
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

    private var waiting: Bool { attention?.isWaiting ?? false }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                StatusIcon(
                    streaming: activity?.streaming == true,
                    attention: attention,
                    todosDone: activity?.hasTodos == true && activity?.todoStatus != nil && activity?.streaming != true
                )
                VStack(alignment: .leading, spacing: 2) {
                    Text(workspace.displayName)
                        .font(.xMono(15, weight: waiting ? .semibold : .medium))
                        .foregroundStyle(waiting ? Color.xWarn : Color.xText)
                        .lineLimit(1)
                    statusLine
                }
                Spacer(minLength: 8)
                VStack(alignment: .trailing, spacing: 3) {
                    Text(RelativeTime.short(activity?.recency ?? workspace.createdAt))
                        .font(.system(size: 13))
                        .foregroundStyle(Color.xText3)
                    if waiting { StatusDot(color: .xAccent) }
                }
            }
            .padding(.horizontal, 16)
            .frame(minHeight: workspace.isScratch ? 60 : 70)
            if !isLast {
                Rectangle().fill(Color.xSep).frame(height: 0.5).padding(.leading, 48)
            }
        }
        .listRowInsets(EdgeInsets())
        .listRowSeparator(.hidden)
        .listRowBackground(
            ZStack {
                shape.fill(Color.xCell)
                if selected { shape.fill(Color.xAccentSoft) }
            }
        )
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
