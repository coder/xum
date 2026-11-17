import Foundation
import Observation

/// Workspaces, projects and live activity for the current server.
@Observable
final class WorkspaceListStore {
    private(set) var projects: [Project] = []
    private(set) var workspaces: [Workspace] = []
    private(set) var activity: [String: WorkspaceActivity] = [:]
    private(set) var attention: [String: Attention] = [:]
    private(set) var loaded = false
    var error: String?

    private(set) var client: APIClient
    private var tasks: [Task<Void, Never>] = []

    init(client: APIClient) { self.client = client }

    var runningCount: Int { activity.values.filter(\.streaming).count }
    var waitingCount: Int { attention.count }

    func workspace(_ id: String) -> Workspace? { workspaces.first { $0.id == id } }

    /// Project sections in server order, each sorted by recency; scratch chats go last.
    var sections: [(title: String, projectPath: String?, items: [Workspace])] {
        var out: [(String, String?, [Workspace])] = []
        for p in projects {
            let ws = workspaces.filter { $0.projectPath == p.path && !$0.isScratch && $0.parentWorkspaceId == nil }
            if ws.isEmpty { continue }
            out.append((p.name, p.path, sortByRecency(ws)))
        }
        let scratch = workspaces.filter(\.isScratch)
        if !scratch.isEmpty { out.append(("Chats", nil, sortByRecency(scratch))) }
        return out
    }

    private func sortByRecency(_ ws: [Workspace]) -> [Workspace] {
        ws.sorted { (activity[$0.id]?.recency ?? $0.createdAt ?? .distantPast) > (activity[$1.id]?.recency ?? $1.createdAt ?? .distantPast) }
    }

    func start() {
        guard tasks.isEmpty else { return }
        tasks.append(Task { [weak self] in await self?.refresh() })
        tasks.append(Task { [weak self] in await self?.followMetadata() })
        tasks.append(Task { [weak self] in await self?.followActivity() })
    }

    func stop() {
        tasks.forEach { $0.cancel() }
        tasks = []
    }

    func refresh() async {
        do {
            let p = try await client.call("projects/list")
            projects = (p.array ?? []).compactMap { pair in
                guard let path = pair[0]?.string else { return nil }
                return Project(path: path, name: URL(fileURLWithPath: path).lastPathComponent)
            }
            let w = try await client.call("workspace/list", [:])
            workspaces = (w.array ?? []).compactMap(Workspace.init(json:))
            let a = try await client.call("workspace/activity/list")
            var act: [String: WorkspaceActivity] = [:]
            for (k, v) in a.object ?? [:] { act[k] = WorkspaceActivity(json: v) }
            activity = act
            loaded = true
            error = nil
            await scanAttention()
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func followMetadata() async {
        while !Task.isCancelled {
            do {
                for try await ev in client.subscribe("workspace/onMetadata", [:]) {
                    if ev["type"]?.string == "snapshot" {
                        workspaces = (ev["workspaces"]?.array ?? []).compactMap(Workspace.init(json:))
                    } else if let id = ev["workspaceId"]?.string {
                        if let m = ev["metadata"], let w = Workspace(json: m) {
                            if let i = workspaces.firstIndex(where: { $0.id == id }) { workspaces[i] = w } else { workspaces.append(w) }
                            if !projects.contains(where: { $0.path == w.projectPath }), !w.projectPath.isEmpty {
                                projects.append(Project(path: w.projectPath, name: w.projectName))
                            }
                        } else {
                            workspaces.removeAll { $0.id == id }
                        }
                    }
                }
            } catch {}
            try? await Task.sleep(nanoseconds: 3_000_000_000)
        }
    }

    private func followActivity() async {
        while !Task.isCancelled {
            do {
                for try await ev in client.subscribe("workspace/activity/subscribe") {
                    guard ev["type"]?.string == "activity", let id = ev["workspaceId"]?.string else { continue }
                    let wasStreaming = activity[id]?.streaming ?? false
                    if let a = ev["activity"], !a.isNull { activity[id] = WorkspaceActivity(json: a) } else { activity[id] = nil }
                    if wasStreaming, activity[id]?.streaming != true { await scan(id) }
                }
            } catch {}
            try? await Task.sleep(nanoseconds: 3_000_000_000)
        }
    }

    /// "Waiting on you" is derived client side (the server has no inbox): replay the chat of each
    /// recent idle workspace and look for an open question or a just-proposed plan.
    func scanAttention() async {
        let recent = workspaces.sorted { (activity[$0.id]?.recency ?? .distantPast) > (activity[$1.id]?.recency ?? .distantPast) }.prefix(12)
        await withTaskGroup(of: Void.self) { g in
            for w in recent { g.addTask { await self.scan(w.id) } }
        }
    }

    func scan(_ id: String) async {
        let store = ChatStore(workspaceId: id, client: client)
        do {
            for try await ev in client.subscribe("workspace/onChat", ["workspaceId": .string(id), "mode": ["type": "full"]]) {
                store.apply(ev)
                if store.caughtUp { break }
            }
        } catch { return }
        if let q = store.pendingQuestion {
            attention[id] = .question(q.questions.first?.question ?? "")
        } else if store.latestPlanToolId != nil, !store.isStreaming {
            attention[id] = .planReady(store.messages.last?.tools.last(where: { $0.name == "propose_plan" })?.input["title"]?.string ?? "Plan")
        } else if let e = store.lastError {
            attention[id] = .error(e)
        } else {
            attention[id] = nil
        }
    }

    func clearAttention(_ id: String) { attention[id] = nil }
}
