import SwiftUI

struct RootView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.horizontalSizeClass) private var sizeClass

    var body: some View {
        @Bindable var model = model
        Group {
            if !model.hasServers {
                WelcomeView()
            } else if sizeClass == .regular {
                RegularRootView()
            } else {
                CompactRootView()
            }
        }
        .sheet(item: sheetBinding) { sheet in
            switch sheet {
            case .connectLink(let prefill): ConnectLinkSheet(prefill: prefill)
            case .servers: ServersSheet()
            case .newChat(let path): NewChatView(projectPath: path)
            case .scanner: EmptyView()
            }
        }
        .fullScreenCover(isPresented: scannerBinding) { ScannerView() }
    }

    private var sheetBinding: Binding<AppSheet?> {
        Binding(get: { model.sheet == .scanner ? nil : model.sheet }, set: { model.sheet = $0 })
    }

    private var scannerBinding: Binding<Bool> {
        Binding(get: { model.sheet == .scanner }, set: { if !$0 { model.sheet = nil } })
    }
}

/// iPhone (and the Duo's outer display): floating tab bar, Workspaces / Inbox / Settings + Search.
struct CompactRootView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var model = model
        TabView(selection: $model.tab) {
            Tab("Workspaces", systemImage: "folder", value: AppTab.workspaces) {
                NavigationStack(path: $model.path) {
                    WorkspacesView()
                        .navigationDestination(for: String.self) { ChatView(workspaceId: $0).id($0) }
                }
            }
            Tab("Inbox", systemImage: "tray", value: AppTab.inbox) {
                NavigationStack { InboxView() }
            }
            .badge(model.list?.waitingCount ?? 0)
            Tab("Settings", systemImage: "gearshape", value: AppTab.settings) {
                NavigationStack { SettingsView() }
            }
            Tab(value: AppTab.search, role: .search) {
                NavigationStack { SearchView() }
            }
        }
        .tabBarMinimizeBehavior(.onScrollDown)
    }
}

/// iPhone Duo inner display (and any regular width): the sidebar owns navigation, with the tab
/// bar turned into a segmented capsule at its bottom (docs/04 §1); the detail stays clean.
struct RegularRootView: View {
    @Environment(AppModel.self) private var model
    @State private var columns: NavigationSplitViewVisibility = .all

    var body: some View {
        NavigationSplitView(columnVisibility: $columns) {
            NavigationStack {
                sidebarContent
                    .safeAreaInset(edge: .bottom) { SidebarTabs().padding(.horizontal, 12).padding(.bottom, 8) }
            }
            .navigationSplitViewColumnWidth(min: 290, ideal: 320, max: 360)
        } detail: {
            NavigationStack {
                detail
            }
        }
        .navigationSplitViewStyle(.balanced)
    }

    @ViewBuilder private var sidebarContent: some View {
        switch model.tab {
        case .inbox: InboxView()
        case .settings: SettingsView()
        case .search: SearchView()
        case .workspaces: WorkspacesView()
        }
    }

    @ViewBuilder private var detail: some View {
        if let id = model.selectedWorkspaceId {
            ChatView(workspaceId: id).id(id)
        } else {
            ContentUnavailableView("Pick a workspace", systemImage: "folder", description: Text("Its chat opens here."))
        }
    }
}

/// Sidebar tabs (`.sbtabs`): 48 high capsule on `fill2`; the selected tab is raised with its label,
/// the others are icon only.
struct SidebarTabs: View {
    @Environment(AppModel.self) private var model

    private let tabs: [(AppTab, String, String)] = [
        (.workspaces, "Workspaces", "folder"), (.inbox, "Inbox", "tray"), (.settings, "Settings", "gearshape"),
    ]

    var body: some View {
        HStack(spacing: 4) {
            ForEach(tabs, id: \.0) { tab, label, icon in
                let selected = model.tab == tab
                Button {
                    model.tab = tab
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: icon)
                        if selected { Text(label).font(.system(size: 14, weight: .semibold)) }
                    }
                    .foregroundStyle(selected ? Color.xAccent : Color.xText2)
                    .frame(maxWidth: selected ? .infinity : 52, minHeight: 40)
                    .background(selected ? Color.xRaised : .clear, in: Capsule())
                    .overlay(alignment: .topTrailing) {
                        if tab == .inbox, let n = model.list?.waitingCount, n > 0 {
                            Text("\(n)").font(.system(size: 11, weight: .bold)).foregroundStyle(.white)
                                .frame(minWidth: 17, minHeight: 17).background(Color.xAccentFill, in: Capsule())
                                .offset(x: -6, y: 2)
                        }
                    }
                    .contentShape(Capsule())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(label)
            }
        }
        .padding(4)
        .frame(height: 48)
        .background(Color.xFill2, in: Capsule())
        .glassEffect(.regular, in: .capsule)
    }
}
