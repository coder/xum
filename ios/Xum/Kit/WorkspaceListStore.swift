import Foundation
import Observation

/// Workspaces, projects and live activity for the current server.
@Observable
final class WorkspaceListStore {
    private(set) var projects: [Project] = []
    private(set) var workspaces: [Workspace] = []
    private(set) var activity: [String: WorkspaceActivity] = [:]
    private(set) var attention: [String: Attention] = [:]
    /// `+N −N` against the trunk, computed client side like the web GitStatusStore.
    private(set) var diffStats: [String: (added: Int, removed: Int)] = [:]
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
                let custom = pair[1]?["displayName"]?.string?.trimmingCharacters(in: .whitespaces)
                return Project(path: path, name: custom?.isEmpty == false ? custom! : URL(fileURLWithPath: path).lastPathComponent)
            }
            let w = try await client.call("workspace/list", [:])
            workspaces = (w.array ?? []).compactMap(Workspace.init(json:))
            pruneAttention()
            let a = try await client.call("workspace/activity/list")
            // `null` means the server could not read activity, not that every workspace is idle.
            if let snapshot = a.object {
                var act: [String: WorkspaceActivity] = [:]
                for (k, v) in snapshot { act[k] = WorkspaceActivity(json: v) }
                activity = act
            }
            loaded = true
            error = nil
            await withTaskGroup(of: Void.self) { g in
                g.addTask { await self.scanAttention() }
                g.addTask { await self.refreshDiffStats() }
            }
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
                        pruneAttention()
                        // A project created while disconnected arrives only as its workspaces' path.
                        workspaces.forEach(addProject(of:))
                    } else if let id = ev["workspaceId"]?.string {
                        if let m = ev["metadata"], let w = Workspace(json: m) {
                            if let i = workspaces.firstIndex(where: { $0.id == id }) { workspaces[i] = w } else { workspaces.append(w) }
                            addProject(of: w)
                        } else {
                            workspaces.removeAll { $0.id == id }
                            attention[id] = nil
                        }
                    }
                }
            } catch {}
            try? await Task.sleep(nanoseconds: 3_000_000_000)
        }
    }

    private func followActivity() async {
        var reconnect = false
        while !Task.isCancelled {
            // The subscription sends changes only, so a turn that started or ended while it was
            // down shows up only in a fresh list. `refresh()` covers the first connection.
            if reconnect { await reconcileActivity() }
            reconnect = true
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

    private func reconcileActivity() async {
        guard let snapshot = (try? await client.call("workspace/activity/list"))?.object else { return }
        var act: [String: WorkspaceActivity] = [:]
        for (k, v) in snapshot { act[k] = WorkspaceActivity(json: v) }
        // A turn ended while disconnected: it was streaming, or it ran and ended unseen (recency moved).
        let old = activity
        let finished = act.filter { id, a in !a.streaming && (old[id]?.streaming == true || old[id]?.recency != a.recency) }.map(\.key)
        activity = act
        for id in finished { await scan(id) }
    }

    /// "Waiting on you" is derived client side (the server has no inbox): replay the chat of each
    /// recent idle workspace and look for an open question or a just-proposed plan.
    /// Every workspace, newest first, at most four replays at a time: the Inbox claims all of
    /// them, so an older idle one with an open question must count too.
    private func addProject(of w: Workspace) {
        guard !w.projectPath.isEmpty, !w.isScratch, !projects.contains(where: { $0.path == w.projectPath }) else { return }
        projects.append(Project(path: w.projectPath, name: w.projectName))
    }

    private func pruneAttention() {
        let ids = Set(workspaces.map(\.id))
        attention = attention.filter { ids.contains($0.key) }
    }

    func scanAttention() async {
        let ordered = workspaces.sorted { (activity[$0.id]?.recency ?? .distantPast) > (activity[$1.id]?.recency ?? .distantPast) }
        await withTaskGroup(of: Void.self) { g in
            var next = ordered.makeIterator()
            for _ in 0..<4 { if let w = next.next() { g.addTask { await self.scan(w.id) } } }
            while await g.next() != nil {
                if let w = next.next() { g.addTask { await self.scan(w.id) } }
            }
        }
    }

    func scan(_ id: String) async {
        let store = ChatStore(workspaceId: id, client: client)
        do {
            for try await ev in client.subscribe("workspace/onChat", ["workspaceId": .string(id), "mode": ["type": "full"]]) {
                store.apply(ev)
                if store.caughtUp || store.replayFailed { break }
            }
        } catch { return }
        // Keep the last answer when the replay did not finish, and never revive a removed workspace.
        guard store.caughtUp, workspaces.contains(where: { $0.id == id }) else { return }
        // An approval blocks a turn that is still streaming, so it comes first.
        if let a = store.sandboxApprovals.first {
            attention[id] = .approval(ChatFormat.firstLine(a.script))
        } else if let q = store.pendingQuestion {
            attention[id] = .question(q.questions.first?.question ?? "")
        } else if store.latestPlanToolId != nil, !store.isStreaming {
            attention[id] = .planReady(store.messages.last?.tools.last(where: { $0.name == "propose_plan" })?.input["title"]?.string ?? "Plan")
        } else if let e = store.lastError {
            attention[id] = .error(e)
        } else {
            attention[id] = nil
        }
    }

    /// File names reach `awk` as `./`-prefixed arguments, never as options, assignments or shell
    /// text: a repository can hold untracked files with any name, and this runs when the list opens.
    func refreshDiffStats() async {
        let script = WorkspaceInfoStore.base + #"; u=$(git ls-files --others --exclude-standard -z | while IFS= read -r -d '' f; do awk 'END {print NR}' "./$f" 2>/dev/null; done | awk '{s+=$1} END {print s+0}'); git diff --numstat "$b" | awk -v u="$u" '{a+=$1;d+=$2} END {print a+u, d+0}'"#
        await withTaskGroup(of: (String, (Int, Int)?).self) { g in
            for w in workspaces where !w.isScratch {
                g.addTask {
                    let r = try? await self.client.call("workspace/executeBash", ["workspaceId": .string(w.id), "script": .string(script), "options": ["timeout_secs": 10]])
                    var out = ""
                    if let o = r?["data"]?["output"]?.string { out = o } else if let o = r?["output"]?.string { out = o }
                    let n = out.split(whereSeparator: \.isWhitespace).compactMap { Int($0) }
                    return (w.id, n.count == 2 ? (n[0], n[1]) : nil)
                }
            }
            for await (id, v) in g { diffStats[id] = v.map { (added: $0.0, removed: $0.1) } }
        }
    }

    /// Opening a workspace shows its failure, so that goes; a question or plan stays until the
    /// chat resolves it (the next scan decides).
    func clearAttention(_ id: String) {
        if case .error? = attention[id] { attention[id] = nil }
    }
}
