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

/// iPhone Duo inner display (and any regular width): workspaces beside the chat.
struct RegularRootView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        NavigationSplitView {
            WorkspacesView()
                .navigationSplitViewColumnWidth(min: 300, ideal: 340, max: 380)
        } detail: {
            if let id = model.selectedWorkspaceId {
                NavigationStack { ChatView(workspaceId: id).id(id) }
            } else {
                ContentUnavailableView("Pick a workspace", systemImage: "square.stack.3d.up", description: Text("Its chat opens here."))
            }
        }
    }
}
