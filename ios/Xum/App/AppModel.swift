import SwiftUI
import Observation

enum AppSheet: Identifiable, Hashable {
    case connectLink(prefill: String?)
    case scanner
    case servers
    case newChat(projectPath: String?)

    var id: String {
        switch self {
        case .connectLink: "link"
        case .scanner: "scanner"
        case .servers: "servers"
        case .newChat: "new"
        }
    }
}

enum AppTab: Hashable { case workspaces, inbox, settings, search }

/// App-wide state: saved servers, the live store of the current server, and navigation.
@Observable
final class AppModel {
    let servers = ServerStore()
    private(set) var list: WorkspaceListStore?
    private var chatStores: [String: ChatStore] = [:]

    var sheet: AppSheet?
    var tab: AppTab = .workspaces
    /// Compact layout: the Workspaces tab's navigation path (workspace IDs).
    var path: [String] = []
    /// Regular layout: the selected workspace beside the list.
    var selectedWorkspaceId: String?
    /// Regular layout sidebar visibility; the tool inspector hides the sidebar so the chat keeps
    /// its column (docs/04 §2, screen 01).
    var splitColumns: NavigationSplitViewVisibility = .all
    /// Regular layout never shows an empty detail once the list loads: it falls back to the top row.
    var shownWorkspaceId: String? { selectedWorkspaceId ?? list?.sections.first?.items.first?.id }

    /// Composer defaults (the server stores per-workspace settings; these seed new chats).
    var defaultModel = "anthropic:claude-opus-5-5"
    var defaultAgent = "exec"
    var defaultThinking: ThinkingLevel = .medium

    init() {
        connectCurrent()
        Task { await servers.refreshAll() }
    }

    var hasServers: Bool { !servers.servers.isEmpty }

    func connectCurrent() {
        list?.stop()
        chatStores.values.forEach { $0.stop() }
        chatStores = [:]
        path = []
        selectedWorkspaceId = nil
        guard let c = servers.currentClient else { list = nil; return }
        let l = WorkspaceListStore(client: c)
        list = l
        l.start()
    }

    func switchServer(_ id: String) {
        guard id != servers.currentID else { return }
        servers.currentID = id
        connectCurrent()
        Task { if let s = servers.current { await servers.refreshReachability(s) } }
    }

    /// Saves a parsed link and makes it current (Connect C confirm, deep links).
    func addServer(_ link: ConnectionLink, name: String, version: String?) {
        servers.add(link: link, name: name, version: version)
        connectCurrent()
        sheet = nil
        Task { if let s = servers.current { await servers.refreshReachability(s) } }
    }

    func forgetServer(_ id: String) {
        let wasCurrent = id == servers.currentID
        servers.forget(id)
        if wasCurrent { connectCurrent() }
    }

    func chatStore(_ workspaceId: String) -> ChatStore? {
        if let s = chatStores[workspaceId] { return s }
        guard let c = servers.currentClient else { return nil }
        let s = ChatStore(workspaceId: workspaceId, client: c)
        chatStores[workspaceId] = s
        s.start()
        return s
    }

    func open(_ workspaceId: String) {
        tab = .workspaces
        selectedWorkspaceId = workspaceId
        path = [workspaceId]
        list?.clearAttention(workspaceId)
    }

    /// `xum://connect?url=…&token=…` and `http(s)://host/?token=…` open the link sheet prefilled.
    func handle(url: URL) {
        let raw = url.absoluteString
        if url.scheme == "xum", url.host() == "open", let id = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "workspace" })?.value {
            open(id)
            return
        }
        if url.scheme == "xum", url.host() == "server",
           let s = servers.servers.first(where: { $0.name == url.lastPathComponent }) {
            switchServer(s.id)
            return
        }
        if url.scheme == "xum", url.host() == "sheet" {
            switch url.lastPathComponent {
            case "servers": sheet = .servers
            case "new": sheet = .newChat(projectPath: nil)
            case "scanner": sheet = .scanner
            case "link": sheet = .connectLink(prefill: nil)
            default: break
            }
            return
        }
        if url.scheme == "xum", url.host() == "tab" {
            switch url.lastPathComponent {
            case "inbox": tab = .inbox
            case "settings": tab = .settings
            case "search": tab = .search
            default: tab = .workspaces
            }
            return
        }
        #if DEBUG
        // Simulator automation: `xum://connect?url=…&token=…&auto=1` saves without the sheet.
        if url.scheme == "xum", URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.contains(where: { $0.name == "auto" }) == true,
           let link = ConnectionLink.parse(raw) {
            addServer(link, name: URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "name" })?.value ?? link.suggestedName, version: nil)
            return
        }
        #endif
        if ConnectionLink.parse(raw) != nil { sheet = .connectLink(prefill: raw) }
    }

    /// Creates a workspace and sends its first message; returns the new ID.
    func createWorkspace(projectPath: String, runtime: RuntimeKind, trunk: String?, message: String,
                         model: String, agentId: String, thinking: ThinkingLevel) async throws -> String {
        guard let c = servers.currentClient else { throw APIError.unauthorized }
        var body: [String: JSONValue] = ["projectPath": .string(projectPath)]
        if let trunk { body["trunkBranch"] = .string(trunk) }
        // Worktree needs a server-side srcBaseDir, so omit it and let the project default apply.
        if runtime == .local { body["runtimeConfig"] = ["type": "local"] }
        if runtime == .worktree {
            body["nameGeneration"] = ["message": .string(message), "candidates": [.string(model)]]
        }
        let res = try await c.call("workspace/create", .object(body))
        guard let id = res["metadata"]?["id"]?.string ?? res["id"]?.string else {
            throw APIError.http(0, res["error"]?.string ?? "Could not create workspace")
        }
        var opts: [String: JSONValue] = ["model": .string(model), "agentId": .string(agentId), "thinkingLevel": .string(thinking.rawValue)]
        opts["sendId"] = .string("ios-" + UUID().uuidString)
        try await c.call("workspace/sendMessage", ["workspaceId": .string(id), "message": .string(message), "options": .object(opts)])
        await list?.refresh()
        return id
    }

    func fork(_ sourceId: String, message: String, model: String, agentId: String, thinking: ThinkingLevel) async throws -> String {
        guard let c = servers.currentClient else { throw APIError.unauthorized }
        let res = try await c.call("workspace/fork", ["sourceWorkspaceId": .string(sourceId), "pendingAutoTitle": true])
        guard let id = res["metadata"]?["id"]?.string else { throw APIError.http(0, res["error"]?.string ?? "Could not fork") }
        try await c.call("workspace/sendMessage", ["workspaceId": .string(id), "message": .string(message),
                                                   "options": ["model": .string(model), "agentId": .string(agentId), "thinkingLevel": .string(thinking.rawValue)]])
        await list?.refresh()
        return id
    }

    func createScratch(projectPath: String?, message: String, model: String, agentId: String, thinking: ThinkingLevel) async throws -> String {
        guard let c = servers.currentClient else { throw APIError.unauthorized }
        _ = projectPath
        let res = try await c.call("workspace/createScratch", ["title": .string(String(message.prefix(48)))])
        guard let id = res["metadata"]?["id"]?.string ?? res["id"]?.string else {
            throw APIError.http(0, res["error"]?.string ?? "Could not create chat")
        }
        try await c.call("workspace/sendMessage", ["workspaceId": .string(id), "message": .string(message),
                                                   "options": ["model": .string(model), "agentId": .string(agentId), "thinkingLevel": .string(thinking.rawValue)]])
        await list?.refresh()
        return id
    }
}
