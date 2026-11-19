import Foundation

enum RuntimeKind: String, Sendable, CaseIterable {
    case worktree, local, ssh, docker, devcontainer, coder, unknown
    var label: String {
        switch self {
        case .worktree: "Worktree"
        case .local: "Local"
        case .ssh: "SSH"
        case .docker: "Docker"
        case .devcontainer: "Dev container"
        case .coder: "Coder"
        case .unknown: "Runtime"
        }
    }
}

struct Workspace: Identifiable, Hashable, Sendable {
    var id: String
    var name: String
    var title: String?
    var projectName: String
    var projectPath: String
    var runtime: RuntimeKind
    var isScratch: Bool
    var parentWorkspaceId: String?
    var createdAt: Date?
    var raw: JSONValue

    /// What rows and chat titles show: the branch-like name (`feature/docs`) for checkouts, the
    /// title for scratch chats.
    var displayName: String {
        if let t = title, !t.isEmpty { return t }
        return name
    }

    init?(json: JSONValue) {
        guard let id = json["id"]?.string else { return nil }
        self.id = id
        name = json["name"]?.string ?? id
        title = json["title"]?.string
        projectName = json["projectName"]?.string ?? ""
        projectPath = json["projectPath"]?.string ?? ""
        let rt = json["runtimeConfig"]?["type"]?.string ?? "local"
        runtime = RuntimeKind(rawValue: rt) ?? .unknown
        isScratch = json["kind"]?.string == "scratch"
        parentWorkspaceId = json["parentWorkspaceId"]?.string ?? json["sideChatParentWorkspaceId"]?.string
        createdAt = json["createdAt"]?.string.flatMap { ISO8601DateFormatter.xum.date(from: $0) }
        raw = json
    }
}

struct StatusLine: Hashable, Sendable {
    var emoji: String
    var message: String
}

struct WorkspaceActivity: Hashable, Sendable {
    var recency: Date?
    var streaming: Bool
    var lastModel: String?
    var lastThinkingLevel: String?
    var displayStatus: StatusLine?
    var todoStatus: StatusLine?
    var hasTodos: Bool

    init(json: JSONValue) {
        recency = json["recency"]?.double.map { Date(timeIntervalSince1970: $0 / 1000) }
        streaming = json["streaming"]?.bool ?? false
        lastModel = json["lastModel"]?.string
        lastThinkingLevel = json["lastThinkingLevel"]?.string
        func status(_ v: JSONValue?) -> StatusLine? {
            guard let v, let m = v["message"]?.string else { return nil }
            return StatusLine(emoji: v["emoji"]?.string ?? "", message: m)
        }
        displayStatus = status(json["displayStatus"])
        todoStatus = status(json["todoStatus"])
        hasTodos = json["hasTodos"]?.bool ?? false
    }

    var statusLine: StatusLine? { displayStatus ?? todoStatus }
}

/// Why a workspace needs you (derived client side; the server has no inbox).
enum Attention: Hashable, Sendable {
    case question(String)
    case planReady(String)
    case error(String)

    var line: String {
        switch self {
        case .question: "Waiting on you · question"
        case .planReady: "Waiting on you · plan ready"
        case .error(let m): m
        }
    }
}

struct Project: Identifiable, Hashable, Sendable {
    var id: String { path }
    var path: String
    var name: String
}

extension ISO8601DateFormatter {
    nonisolated(unsafe) static let xum: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
}

enum RelativeTime {
    /// `now`, `4m`, `1h`, `Tue`, `Nov 3`.
    static func short(_ date: Date?, now: Date = Date()) -> String {
        guard let date else { return "" }
        let s = now.timeIntervalSince(date)
        if s < 60 { return "now" }
        if s < 3600 { return "\(Int(s / 60))m" }
        if s < 86400 { return "\(Int(s / 3600))h" }
        let f = DateFormatter()
        f.dateFormat = s < 6 * 86400 ? "EEE" : "MMM d"
        return f.string(from: date)
    }
}

/// Model ids come as `provider:model`. Short display names for the composer chip.
enum ModelName {
    static func display(_ id: String?) -> String {
        guard let id, !id.isEmpty else { return "Model" }
        let model = id.split(separator: ":", maxSplits: 1).last.map(String.init) ?? id
        let known: [String: String] = [
            "claude-opus-5-5": "Opus 5.5", "claude-sonnet-5-5": "Sonnet 5.5", "claude-haiku-5-5": "Haiku 5.5",
            "claude-fable-5-2": "Fable 5.2", "gpt-6.2-sol": "GPT-6.2 Sol",
            "gemini-3.1-pro-preview": "Gemini 3.1 Pro",
        ]
        if let k = known[model] { return k }
        // Local quantized builds (`GLM-5.3-Flash-oQ4e-mtp`): keep the family and size.
        if let r = model.range(of: #"-(o?Q\d.*|mtp|gguf|mlx.*)$"#, options: [.regularExpression, .caseInsensitive]) {
            return display(String(model[..<r.lowerBound]))
        }
        var s = model.replacingOccurrences(of: "claude-", with: "")
        if let slash = s.lastIndex(of: "/") { s = String(s[s.index(after: slash)...]) }
        return s.split(separator: "-").map { $0.prefix(1).uppercased() + $0.dropFirst() }.joined(separator: " ")
    }
    static func provider(_ id: String) -> String { id.split(separator: ":").first.map(String.init) ?? "" }

    /// Built-in choices, offered for the providers a server has configured.
    static let builtIn = [
        "anthropic:claude-opus-5-5", "anthropic:claude-sonnet-5-5", "anthropic:claude-haiku-5-5",
        "anthropic:claude-fable-5-2", "openai:gpt-6.2-sol", "google:gemini-3.1-pro-preview",
    ]

    /// The models a server can run, from `providers.getConfig`: the built-ins of each configured,
    /// enabled provider, then each provider's own model list (custom and local providers).
    static func catalog(providers: JSONValue) -> [String] {
        let usable = (providers.object ?? [:]).filter { $0.value["isConfigured"]?.bool == true && $0.value["isEnabled"]?.bool != false }
        var out = builtIn.filter { usable[provider($0)] != nil }
        for (name, info) in usable.sorted(by: { $0.key < $1.key }) {
            for entry in info["models"]?.array ?? [] {
                guard let id = entry.string ?? entry["id"]?.string else { continue }
                let full = "\(name):\(id)"
                if !out.contains(full) { out.append(full) }
            }
        }
        return out
    }

    /// Input token limit for the context ring, from `max_input_tokens` in
    /// src/common/utils/tokens/models-extra.ts; other models fall back to 200K.
    static func contextWindow(_ id: String?) -> Int {
        let model = id?.split(separator: ":", maxSplits: 1).last.map(String.init) ?? ""
        let known: [String: Int] = [
            "claude-opus-5-5": 1_000_000, "claude-sonnet-5-5": 1_000_000, "claude-haiku-5-5": 1_000_000,
            "claude-fable-5-2": 1_000_000, "gpt-6.2-sol": 922_000, "gemini-3.1-pro-preview": 1_048_576,
        ]
        return known[model] ?? 200_000
    }
}

enum ThinkingLevel: String, CaseIterable, Sendable {
    case off, low, medium, high, xhigh, max
    var chip: String {
        switch self {
        case .off: "OFF"
        case .low: "LOW"
        case .medium: "MED"
        case .high: "HIGH"
        case .xhigh: "XHIGH"
        case .max: "MAX"
        }
    }
    var label: String {
        switch self {
        case .off: "Off"
        case .low: "Low"
        case .medium: "Medium"
        case .high: "High"
        case .xhigh: "XHigh"
        case .max: "Max"
        }
    }
}
