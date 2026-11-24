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
    /// Regular layout: the Settings page shown in the detail column while the Settings tab is open.
    var settingsPage: SettingsPage? = .serverAccess
    /// Regular layout never shows an empty detail once the list loads: it falls back to the top row,
    /// also when the selected workspace is gone (archived or removed elsewhere).
    var shownWorkspaceId: String? {
        if let id = selectedWorkspaceId, list?.loaded != true || list?.workspace(id) != nil { return id }
        return list?.sections.first?.items.first?.id
    }

    /// Composer defaults (the server stores per-workspace settings; these seed new chats).
    var defaultModel = "anthropic:claude-opus-5-5"
    /// The current server's usable models (`ModelName.catalog`); the built-ins until it loads.
    private(set) var serverModels: [String] = []
    var modelChoices: [String] { serverModels.isEmpty ? ModelName.builtIn : serverModels }

    /// A server with only local or custom models must not get a fixed Anthropic default: its
    /// first send would be refused. The server's own default wins, else its first usable model.
    func loadModels() async {
        guard let c = servers.currentClient else { return }
        let serverID = servers.currentID
        guard let providers = try? await c.call("providers/getConfig") else { return }
        let serverDefault = (try? await c.call("config/getConfig"))?["defaultModel"]?.string
        // A switch while these calls ran started a newer load for the new server.
        guard servers.currentID == serverID else { return }
        var models = ModelName.catalog(providers: providers)
        // The server's own default is valid by its routing even when this catalog misses it.
        if let d = serverDefault, !d.isEmpty, !models.contains(d) { models.insert(d, at: 0) }
        serverModels = models
        guard !models.isEmpty else { return }
        if let d = serverDefault, models.contains(d) {
            defaultModel = d
        } else if !models.contains(defaultModel) {
            defaultModel = models[0]
        }
    }
    var defaultAgent = "exec"
    var defaultThinking: ThinkingLevel = .medium

    init() {
        connectCurrent()
        Task { await servers.refreshAll() }
    }

    var hasServers: Bool { !servers.servers.isEmpty }

    func connectCurrent() {
        list?.stop()
        chatStores.values.forEach { $0.close() }
        chatStores = [:]
        chatOrder = []
        path = []
        selectedWorkspaceId = nil
        guard let c = servers.currentClient else { list = nil; return }
        let l = WorkspaceListStore(client: c)
        // An open chat whose workspace is gone would keep offering sends the server refuses.
        l.onRemoved = { [weak self] id in
            self?.path.removeAll { $0 == id }
            if self?.selectedWorkspaceId == id { self?.selectedWorkspaceId = nil }
        }
        list = l
        l.start()
        serverModels = []
        Task { await loadModels() }
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

    /// Live chats, most recent last. Each holds an SSE stream and a transcript, so only the
    /// last few stay open; an evicted one replays again when it is reopened.
    private var chatOrder: [String] = []
    private static let liveChatLimit = 3

    func chatStore(_ workspaceId: String) -> ChatStore? {
        chatOrder.removeAll { $0 == workspaceId }
        chatOrder.append(workspaceId)
        while chatOrder.count > Self.liveChatLimit {
            let old = chatOrder.removeFirst()
            chatStores.removeValue(forKey: old)?.close()
        }
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

    /// Creates a workspace and starts sending its first message; returns the new ID.
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
        startFirstSend(c, id, message, model: model, agentId: agentId, thinking: thinking)
        return id
    }

    /// A first message that did not send: why, and its text unless the workspace's draft
    /// confirmed it holds that text (a retry then sends it there instead of making another workspace).
    struct UnsentFirstMessage {
        var reason: String
        var text: String?
    }

    /// The unsent first message of each workspace, until its chat takes it.
    private(set) var unsentFirstMessages: [String: UnsentFirstMessage] = [:]
    func takeUnsentFirstMessage(_ workspaceId: String) -> UnsentFirstMessage? { unsentFirstMessages.removeValue(forKey: workspaceId) }

    /// The web creation flow's first send: no client send id (the backend mints one) and no
    /// draft entry. `sendMessage` returns only when the turn ends, so the new workspace opens
    /// first: a first turn that asks a question or needs a sandbox approval waits on a card the
    /// user must see. On failure the text goes to the workspace's draft unless that already
    /// holds something (the web's transferDraftToWorkspace).
    private func startFirstSend(_ c: APIClient, _ id: String, _ message: String, model: String, agentId: String, thinking: ThinkingLevel) {
        let opts: [String: JSONValue] = ["model": .string(model), "agentId": .string(agentId), "thinkingLevel": .string(thinking.rawValue)]
        Task {
            do {
                try await c.call("workspace/sendMessage", ["workspaceId": .string(id), "message": .string(message), "options": .object(opts)])
            } catch {
                let scope: JSONValue = ["kind": "workspace", "workspaceId": .string(id)]
                // The draft calls often fail for the same reason the send did. Until a write is
                // confirmed, the text stays here and the chat restores it through its own draft,
                // whose writes retry.
                var kept: String? = message
                if let current = try? await c.call("drafts/get", ["scope": scope]) {
                    if (current["text"]?.string ?? "").isEmpty, (current["attachments"]?.array ?? []).isEmpty {
                        if (try? await c.call("drafts/update", ["scope": scope, "text": .string(message)])) != nil { kept = nil }
                    } else {
                        // The draft already holds something, so the message does not go there.
                        kept = nil
                    }
                }
                unsentFirstMessages[id] = UnsentFirstMessage(reason: error.localizedDescription, text: kept)
            }
        }
        Task { await list?.refresh() }
    }

    func fork(_ sourceId: String, message: String, model: String, agentId: String, thinking: ThinkingLevel) async throws -> String {
        guard let c = servers.currentClient else { throw APIError.unauthorized }
        let res = try await c.call("workspace/fork", ["sourceWorkspaceId": .string(sourceId), "pendingAutoTitle": true])
        guard let id = res["metadata"]?["id"]?.string else { throw APIError.http(0, res["error"]?.string ?? "Could not fork") }
        startFirstSend(c, id, message, model: model, agentId: agentId, thinking: thinking)
        return id
    }

    func createScratch(projectPath: String?, message: String, model: String, agentId: String, thinking: ThinkingLevel) async throws -> String {
        guard let c = servers.currentClient else { throw APIError.unauthorized }
        _ = projectPath
        let res = try await c.call("workspace/createScratch", ["title": .string(String(message.prefix(48)))])
        guard let id = res["metadata"]?["id"]?.string ?? res["id"]?.string else {
            throw APIError.http(0, res["error"]?.string ?? "Could not create chat")
        }
        startFirstSend(c, id, message, model: model, agentId: agentId, thinking: thinking)
        return id
    }
}
