import Foundation
import Observation

/// Token and cost totals of one model (`workspace.getSessionUsage` byModel entry).
struct ModelUsage: Identifiable, Hashable, Sendable {
    struct Bucket: Hashable, Sendable { var tokens: Int; var cost: Double? }
    var id: String { model }
    var model: String
    var input: Bucket
    var cached: Bucket
    var cacheCreate: Bucket
    var output: Bucket
    var reasoning: Bucket
    var hasUnknownCosts: Bool

    var buckets: [(String, Bucket)] {
        [("Input", input), ("Cached", cached), ("Cache write", cacheCreate), ("Output", output), ("Reasoning", reasoning)]
    }
    var totalTokens: Int { buckets.reduce(0) { $0 + $1.1.tokens } }
    var cost: Double { buckets.reduce(0) { $0 + ($1.1.cost ?? 0) } }

    mutating func add(_ o: ModelUsage) {
        func sum(_ a: Bucket, _ b: Bucket) -> Bucket {
            Bucket(tokens: a.tokens + b.tokens, cost: a.cost == nil && b.cost == nil ? nil : (a.cost ?? 0) + (b.cost ?? 0))
        }
        input = sum(input, o.input)
        cached = sum(cached, o.cached)
        cacheCreate = sum(cacheCreate, o.cacheCreate)
        output = sum(output, o.output)
        reasoning = sum(reasoning, o.reasoning)
        hasUnknownCosts = hasUnknownCosts || o.hasUnknownCosts
    }

    init(model: String, json j: JSONValue) {
        func bucket(_ k: String) -> Bucket { Bucket(tokens: j[k]?["tokens"]?.int ?? 0, cost: j[k]?["cost_usd"]?.double) }
        self.model = model
        input = bucket("input")
        cached = bucket("cached")
        cacheCreate = bucket("cacheCreate")
        output = bucket("output")
        reasoning = bucket("reasoning")
        hasUnknownCosts = j["hasUnknownCosts"]?.bool ?? false
    }
}

/// Response timing (`workspace.stats.subscribe`): the last request and session totals.
struct TimingStats: Hashable, Sendable {
    struct Request: Hashable, Sendable {
        var model: String?
        var totalMs: Double
        var ttftMs: Double?
        var toolMs: Double
        var modelMs: Double
        var streamingMs: Double
        var outputTokens: Int
        var tokensPerSecond: Double? { streamingMs > 0 && outputTokens > 0 ? Double(outputTokens) / (streamingMs / 1000) : nil }
    }
    var last: Request?
    var responses: Int
    var sessionMs: Double
    var sessionToolMs: Double
    var avgTtftMs: Double?
    var sessionOutputTokens: Int

    init(json j: JSONValue) {
        if let r = j["lastRequest"], !r.isNull {
            last = Request(model: r["model"]?.string, totalMs: r["totalDurationMs"]?.double ?? 0, ttftMs: r["ttftMs"]?.double,
                           toolMs: r["toolExecutionMs"]?.double ?? 0, modelMs: r["modelTimeMs"]?.double ?? 0,
                           streamingMs: r["streamingMs"]?.double ?? 0, outputTokens: r["outputTokens"]?.int ?? 0)
        }
        let s = j["session"]
        responses = s?["responseCount"]?.int ?? 0
        sessionMs = s?["totalDurationMs"]?.double ?? 0
        sessionToolMs = s?["totalToolExecutionMs"]?.double ?? 0
        let ttftCount = s?["ttftCount"]?.double ?? 0
        avgTtftMs = ttftCount > 0 ? (s?["totalTtftMs"]?.double ?? 0) / ttftCount : nil
        sessionOutputTokens = s?["totalOutputTokens"]?.int ?? 0
    }
}

struct ArtifactEntry: Identifiable, Hashable, Sendable {
    var id: String { path }
    var path: String
    var kind: String
    var size: Int
    var modified: Date
}

enum ArtifactContent: Sendable {
    case text(String)
    case image(Data)
    case tooLarge(Int)
    case binary
}

struct ChangedFile: Identifiable, Hashable, Sendable {
    var id: String { path }
    var path: String
    var added: Int
    var removed: Int
    var untracked: Bool
}

/// The right-sidebar data of one workspace (desktop's Costs, Stats, Artifacts and Review tabs),
/// loaded on demand while the info panel is visible.
@Observable
final class WorkspaceInfoStore {
    let workspaceId: String
    private let client: APIClient

    private(set) var usage: [ModelUsage] = []
    private(set) var contextTokens: Int?
    private(set) var contextModel: String?
    private(set) var usageLoaded = false
    private(set) var timing: TimingStats?

    private(set) var artifacts: [ArtifactEntry] = []
    /// Set when the server cannot list artifacts (experiment off, runtime without a scratch dir).
    private(set) var artifactsUnavailable: String?
    private(set) var artifactsLoaded = false

    private(set) var changes: [ChangedFile] = []
    private(set) var changesBase: String?
    private(set) var changesError: String?
    private(set) var changesLoaded = false

    init(workspaceId: String, client: APIClient) {
        self.workspaceId = workspaceId
        self.client = client
    }

    private var ws: JSONValue { ["workspaceId": .string(workspaceId)] }

    var totalCost: Double { usage.reduce(0) { $0 + $1.cost } }
    var hasUnknownCosts: Bool { usage.contains(where: \.hasUnknownCosts) }

    func loadUsage() async {
        async let subagents = try? client.call("workspace/getSubagentUsage", ws)
        guard let r = try? await client.call("workspace/getSessionUsage", ws) else { usageLoaded = true; return }
        var byModel: [String: ModelUsage] = [:]
        for (k, v) in r["byModel"]?.object ?? [:] { byModel[k] = ModelUsage(model: k, json: v) }
        // Live sub-agents are not in the ledger yet; skip a child already rolled up into it, as
        // the desktop Costs tab does, so it is not counted twice.
        let rolledUp = Set((r["rolledUpFrom"]?.object ?? [:]).keys)
        for (child, entry) in await subagents?["children"]?.object ?? [:] where !rolledUp.contains(child) {
            for (k, v) in entry["byModel"]?.object ?? [:] {
                let u = ModelUsage(model: k, json: v)
                if byModel[k] == nil { byModel[k] = u } else { byModel[k]?.add(u) }
            }
        }
        usage = byModel.values.sorted { $0.cost == $1.cost ? $0.totalTokens > $1.totalTokens : $0.cost > $1.cost }
        if let u = r["lastRequest"]?["usage"] {
            contextTokens = ["input", "cached", "cacheCreate"].reduce(0) { $0 + (u[$1]?["tokens"]?.int ?? 0) }
            contextModel = r["lastRequest"]?["model"]?.string
        }
        usageLoaded = true
    }

    /// Follows the timing snapshot stream until the calling task is cancelled.
    func followTiming() async {
        do {
            for try await ev in client.subscribe("workspace/stats/subscribe", ws) { timing = TimingStats(json: ev) }
        } catch {}
    }

    func loadArtifacts() async {
        do {
            let r = try await client.call("artifacts/list", ws)
            if r["data"]?["available"]?.bool == false {
                artifactsUnavailable = r["data"]?["reason"]?.string ?? "Artifacts are not available"
            } else {
                artifactsUnavailable = nil
                artifacts = (r["data"]?["entries"]?.array ?? []).compactMap { e in
                    guard let p = e["path"]?.string else { return nil }
                    return ArtifactEntry(path: p, kind: e["kind"]?.string ?? "text", size: e["size"]?.int ?? 0,
                                         modified: Date(timeIntervalSince1970: (e["modifiedMs"]?.double ?? 0) / 1000))
                }
            }
        } catch APIError.http(_, let body) {
            let message = JSONValue.parse(Data(body.utf8))?["message"]?.string ?? body
            artifactsUnavailable = message == "Artifacts are disabled"
                ? "Artifacts are turned off on this server. Turn on the Artifacts experiment in Xum's Settings → Experiments."
                : message
        } catch {
            artifactsUnavailable = error.localizedDescription
        }
        artifactsLoaded = true
    }

    /// Text of the last artifact read, for the preview's share button.
    private(set) var lastReadText: String?

    func readArtifact(_ path: String) async throws -> ArtifactContent {
        lastReadText = nil
        let r = try await client.call("artifacts/read", ["workspaceId": .string(workspaceId), "path": .string(path)])
        guard let d = r["data"] else { throw APIError.decoding }
        switch d["status"]?.string {
        case "too_large": return .tooLarge(d["size"]?.int ?? 0)
        case "binary": return .binary
        default:
            let content = d["content"]?.string ?? ""
            if d["encoding"]?.string == "base64" { return .image(Data(base64Encoded: content) ?? Data()) }
            lastReadText = content
            return .text(content)
        }
    }

    // MARK: - Changes (git, through executeBash like the desktop Review tab)

    /// Diff base: the merge base with origin/main (or main), else HEAD.
    private static let base = #"b=$(git merge-base HEAD origin/main 2>/dev/null || git merge-base HEAD main 2>/dev/null || git rev-parse HEAD)"#

    private func bash(_ script: String) async throws -> String {
        let r = try await client.call("workspace/executeBash", ["workspaceId": .string(workspaceId), "script": .string(script),
                                                                "options": ["timeout_secs": 15]])
        let result = r["data"] ?? r
        return result["output"]?.string ?? ""
    }

    func loadChanges() async {
        do {
            let out = try await bash(Self.base + #"; printf 'BASE %s\0' "$b"; git diff --numstat -z "$b"; printf 'UNTRACKED\0'; git ls-files --others --exclude-standard -z | while IFS= read -r -d '' f; do printf '%s\0%s\0' "$(wc -l < "$f" | tr -d ' ')" "$f"; done"#)
            (changesBase, changes) = Self.parseChanges(out)
            changesError = nil
        } catch {
            changesError = error.localizedDescription
        }
        changesLoaded = true
    }

    /// NUL-separated records, so any byte in a path survives: `BASE <sha>`, then `git diff
    /// --numstat -z` records (`added\tremoved\tpath`, or `added\tremoved\t` then the old and new
    /// paths of a rename), then `UNTRACKED` and `lines`, `path` pairs. A numstat record always has
    /// two tabs, so the marker cannot be mistaken for one.
    static func parseChanges(_ out: String) -> (base: String?, files: [ChangedFile]) {
        var fields = out.split(separator: "\0", omittingEmptySubsequences: false).map(String.init)[...]
        var base: String?
        if let first = fields.first, first.hasPrefix("BASE ") {
            base = String(first.dropFirst(5).prefix(8))
            fields = fields.dropFirst()
        }
        var files: [ChangedFile] = []
        while let record = fields.popFirst(), record != "UNTRACKED" {
            let cols = record.split(separator: "\t", maxSplits: 2, omittingEmptySubsequences: false).map(String.init)
            guard cols.count == 3 else { continue }
            var path = cols[2]
            if path.isEmpty {
                _ = fields.popFirst()
                path = fields.popFirst() ?? ""
            }
            if !path.isEmpty { files.append(ChangedFile(path: path, added: Int(cols[0]) ?? 0, removed: Int(cols[1]) ?? 0, untracked: false)) }
        }
        while let lines = fields.popFirst(), let path = fields.popFirst() {
            if !path.isEmpty { files.append(ChangedFile(path: path, added: Int(lines) ?? 0, removed: 0, untracked: true)) }
        }
        return (base, files)
    }

    func diff(_ file: ChangedFile) async throws -> String {
        let quoted = "'" + file.path.replacingOccurrences(of: "'", with: "'\\''") + "'"
        if file.untracked { return try await bash("git diff --no-index -- /dev/null \(quoted); true") }
        return try await bash(Self.base + "; git diff \"$b\" -- \(quoted)")
    }
}
