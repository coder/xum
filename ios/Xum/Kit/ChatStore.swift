import Foundation
import Observation

enum ToolState: Hashable, Sendable { case running, done, failed }

struct ToolCall: Identifiable, Hashable, Sendable {
    var id: String
    var name: String
    var input: JSONValue
    var output: JSONValue?
    var state: ToolState
    var startedAt: Date?
    var endedAt: Date?
    var liveOutput: String = ""

    var duration: TimeInterval? {
        guard let s = startedAt else { return nil }
        return (endedAt ?? Date()).timeIntervalSince(s)
    }
}

enum ChatPart: Hashable, Sendable, Identifiable {
    case text(id: String, String)
    case reasoning(id: String, String)
    case tool(ToolCall)

    var id: String {
        switch self {
        case .text(let id, _), .reasoning(let id, _): id
        case .tool(let t): t.id
        }
    }
}

enum ChatRole: String, Sendable { case user, assistant, system }

struct ChatMessage: Identifiable, Hashable, Sendable {
    var id: String
    var role: ChatRole
    var parts: [ChatPart]
    var model: String?
    var agentId: String?
    var timestamp: Date?
    var historySequence: Int?
    var isStreaming = false
    var reasoningStartedAt: Date?
    var reasoningEndedAt: Date?

    var text: String {
        parts.compactMap { if case .text(_, let t) = $0 { return t }; return nil }.joined()
    }
    var tools: [ToolCall] { parts.compactMap { if case .tool(let t) = $0 { return t }; return nil } }
}

struct TodoItem: Hashable, Sendable {
    var content: String
    var status: String
}

/// Open `ask_user_question` call: the question card replaces the composer.
struct PendingQuestion: Hashable, Sendable {
    struct Option: Hashable, Sendable { var label: String; var description: String }
    struct Question: Hashable, Sendable {
        var question: String
        var header: String
        var options: [Option]
        var multiSelect: Bool
    }
    var toolCallId: String
    var questions: [Question]
    /// Non-blocking questions returned at once and take their answer as a normal message.
    var answerByMessage: Bool

    init?(tool: ToolCall) {
        guard tool.name == "ask_user_question", let qs = tool.input["questions"]?.array else { return nil }
        let async = tool.output?["ui_only"]?["ask_user_question"]?["answerDelivery"]?.string == "message"
        guard async || (tool.output == nil && tool.state == .running) else { return nil }
        answerByMessage = async
        toolCallId = tool.id
        questions = qs.compactMap { q in
            guard let text = q["question"]?.string else { return nil }
            let opts = (q["options"]?.array ?? []).compactMap { o -> Option? in
                guard let l = o["label"]?.string else { return nil }
                return Option(label: l, description: o["description"]?.string ?? "")
            }
            return Question(question: text, header: q["header"]?.string ?? "", options: opts, multiSelect: q["multiSelect"]?.bool ?? false)
        }
        if questions.isEmpty { return nil }
    }
}

/// One workspace's chat: replays `workspace.onChat` (full) then applies live events, mirroring the
/// web client's StreamingMessageAggregator closely enough for the phone UI. Unknown events are
/// ignored so newer servers never break the app.
@Observable
final class ChatStore {
    let workspaceId: String
    private(set) var messages: [ChatMessage] = []
    private(set) var caughtUp = false
    private(set) var streamingMessageId: String?
    private(set) var lastError: String?
    private(set) var contextTokens: Int?
    private(set) var hasQueued = false
    var connectionError: String?

    private var client: APIClient
    private var task: Task<Void, Never>?

    init(workspaceId: String, client: APIClient) {
        self.workspaceId = workspaceId
        self.client = client
    }

    var isStreaming: Bool { streamingMessageId != nil }

    var todos: [TodoItem] {
        for m in messages.reversed() {
            for t in m.tools.reversed() where t.name == "todo_write" {
                return (t.input["todos"]?.array ?? []).compactMap {
                    guard let c = $0["content"]?.string else { return nil }
                    return TodoItem(content: c, status: $0["status"]?.string ?? "pending")
                }
            }
        }
        return []
    }

    /// Tool call IDs answered by a later user message (`muxMetadata.askUserQuestionAnswer`).
    private(set) var answeredQuestionIds: Set<String> = []

    var pendingQuestion: PendingQuestion? {
        for m in messages.reversed() {
            // A user message after the question means the turn moved on.
            if m.role == .user { return nil }
            for t in m.tools.reversed() {
                if let q = PendingQuestion(tool: t), !answeredQuestionIds.contains(q.toolCallId) { return q }
            }
        }
        return nil
    }

    /// The last proposed plan, when it is the newest assistant output (so the card shows Implement).
    var latestPlanToolId: String? {
        guard let last = messages.last(where: { $0.role == .assistant }) else { return nil }
        return last.tools.last(where: { $0.name == "propose_plan" })?.id
    }

    var lastModel: String? { messages.last(where: { $0.role == .assistant && $0.model != nil })?.model }

    func start() {
        guard task == nil else { return }
        task = Task { [weak self] in await self?.run() }
    }

    func stop() {
        task?.cancel()
        task = nil
    }

    private func run() async {
        var backoff: UInt64 = 1
        while !Task.isCancelled {
            do {
                resetForReplay()
                for try await ev in client.subscribe("workspace/onChat", ["workspaceId": .string(workspaceId), "mode": ["type": "full"]]) {
                    connectionError = nil
                    backoff = 1
                    apply(ev)
                }
            } catch is CancellationError {
                return
            } catch {
                if Task.isCancelled { return }
                connectionError = error.localizedDescription
            }
            try? await Task.sleep(nanoseconds: backoff * 1_000_000_000)
            backoff = min(backoff * 2, 15)
        }
    }

    private func resetForReplay() {
        messages = []
        answeredQuestionIds = []
        caughtUp = false
        streamingMessageId = nil
    }

    // MARK: - Event application

    func apply(_ ev: JSONValue) {
        let type = ev["type"]?.string
        if type == nil || type == "message", ev["role"] != nil {
            upsertPersisted(ev)
            return
        }
        switch type {
        case "message-batch":
            for m in ev["messages"]?.array ?? [] { apply(m) }
        case "caught-up":
            caughtUp = true
        case "stream-start":
            guard let id = ev["messageId"]?.string else { return }
            var m = ChatMessage(id: id, role: .assistant, parts: [], model: ev["model"]?.string, agentId: ev["agentId"]?.string,
                                timestamp: date(ev["startTime"]), historySequence: ev["historySequence"]?.int)
            m.isStreaming = true
            upsert(m)
            streamingMessageId = id
            lastError = nil
        case "stream-delta":
            mutate(ev["messageId"]?.string) { m in
                let delta = ev["delta"]?.string ?? ""
                if case .text(let pid, let t)? = m.parts.last {
                    m.parts[m.parts.count - 1] = .text(id: pid, t + delta)
                } else {
                    m.parts.append(.text(id: "\(m.id)-t\(m.parts.count)", delta))
                }
                if m.reasoningStartedAt != nil, m.reasoningEndedAt == nil { m.reasoningEndedAt = Date() }
            }
        case "reasoning-delta":
            mutate(ev["messageId"]?.string) { m in
                let delta = ev["delta"]?.string ?? ""
                if m.reasoningStartedAt == nil { m.reasoningStartedAt = date(ev["timestamp"]) ?? Date() }
                if case .reasoning(let pid, let t)? = m.parts.last {
                    m.parts[m.parts.count - 1] = .reasoning(id: pid, t + delta)
                } else {
                    m.parts.append(.reasoning(id: "\(m.id)-r\(m.parts.count)", delta))
                }
            }
        case "reasoning-end":
            mutate(ev["messageId"]?.string) { m in m.reasoningEndedAt = m.reasoningEndedAt ?? Date() }
        case "tool-call-start":
            mutate(ev["messageId"]?.string) { m in
                guard let tid = ev["toolCallId"]?.string else { return }
                let t = ToolCall(id: tid, name: ev["toolName"]?.string ?? "tool", input: ev["args"] ?? .null, output: nil,
                                 state: .running, startedAt: date(ev["timestamp"]) ?? Date(), endedAt: nil)
                if let i = m.parts.firstIndex(where: { $0.id == tid }) { m.parts[i] = .tool(t) } else { m.parts.append(.tool(t)) }
            }
        case "tool-call-end":
            mutate(ev["messageId"]?.string) { m in
                guard let tid = ev["toolCallId"]?.string, let i = m.parts.firstIndex(where: { $0.id == tid }),
                      case .tool(var t) = m.parts[i] else { return }
                t.output = ev["result"]
                t.endedAt = date(ev["timestamp"]) ?? Date()
                t.state = Self.failed(t.output) ? .failed : .done
                m.parts[i] = .tool(t)
            }
        case "bash-output":
            guard let tid = ev["toolCallId"]?.string, let text = ev["text"]?.string else { return }
            for mi in messages.indices.reversed() {
                if let pi = messages[mi].parts.firstIndex(where: { $0.id == tid }), case .tool(var t) = messages[mi].parts[pi] {
                    t.liveOutput += text
                    messages[mi].parts[pi] = .tool(t)
                    return
                }
            }
        case "stream-end":
            mutate(ev["messageId"]?.string) { m in
                if let parts = ev["parts"]?.array { m.parts = Self.parseParts(parts, messageId: m.id) }
                m.isStreaming = false
                m.model = ev["metadata"]?["model"]?.string ?? m.model
                if let ctx = ev["metadata"]?["contextUsage"]?["inputTokens"]?.int { contextTokens = ctx }
                if m.reasoningStartedAt != nil, m.reasoningEndedAt == nil { m.reasoningEndedAt = Date() }
            }
            if streamingMessageId == ev["messageId"]?.string { streamingMessageId = nil }
        case "stream-abort":
            mutate(ev["messageId"]?.string) { m in
                m.isStreaming = false
                m.parts = m.parts.map { p in
                    if case .tool(var t) = p, t.state == .running { t.state = .failed; t.endedAt = Date(); return .tool(t) }
                    return p
                }
            }
            if streamingMessageId == ev["messageId"]?.string { streamingMessageId = nil }
        case "stream-error", "error":
            lastError = ev["error"]?.string ?? "Stream failed"
            mutate(ev["messageId"]?.string) { m in m.isStreaming = false }
            streamingMessageId = nil
        case "usage-delta":
            if let n = ev["usage"]?["inputTokens"]?.int { contextTokens = n }
        case "delete":
            let seqs = Set((ev["historySequences"]?.array ?? []).compactMap(\.int))
            messages.removeAll { $0.historySequence.map(seqs.contains) ?? false }
        case "queued-message-changed":
            hasQueued = ev["hasQueuedMessages"]?.bool ?? false
        default:
            break
        }
    }

    private func upsertPersisted(_ ev: JSONValue) {
        guard let id = ev["id"]?.string, let roleS = ev["role"]?.string else { return }
        let meta = ev["metadata"]
        // Synthetic user rows (TODO nudges, system notifications) are not shown unless the server
        // marks them visible, matching the web UI.
        if roleS == "user", meta?["synthetic"]?.bool == true, meta?["uiVisible"]?.bool != true { return }
        if roleS == "user", let t = ev["parts"]?[0]?["text"]?.string, t.hasPrefix("<notification>") { return }
        if let a = meta?["muxMetadata"]?["askUserQuestionAnswer"] {
            for e in a.array ?? [a] { if let id = e["toolCallId"]?.string { answeredQuestionIds.insert(id) } }
        }
        let role = ChatRole(rawValue: roleS) ?? .system
        guard role != .system else { return }
        var m = ChatMessage(id: id, role: role, parts: Self.parseParts(ev["parts"]?.array ?? [], messageId: id),
                            model: meta?["model"]?.string, agentId: meta?["agentId"]?.string,
                            timestamp: date(meta?["timestamp"]), historySequence: meta?["historySequence"]?.int)
        if role == .assistant, let ctx = meta?["contextUsage"]?["inputTokens"]?.int { contextTokens = ctx }
        if m.parts.isEmpty, role == .assistant, messages.contains(where: { $0.id == id }) { return }
        if let existing = messages.first(where: { $0.id == id }) {
            m.isStreaming = existing.isStreaming && streamingMessageId == id
            m.reasoningStartedAt = existing.reasoningStartedAt
            m.reasoningEndedAt = existing.reasoningEndedAt
        }
        upsert(m)
    }

    private func upsert(_ m: ChatMessage) {
        if let i = messages.firstIndex(where: { $0.id == m.id }) { messages[i] = m } else { messages.append(m) }
    }

    private func mutate(_ id: String?, _ f: (inout ChatMessage) -> Void) {
        guard let id else { return }
        if messages.firstIndex(where: { $0.id == id }) == nil {
            var m = ChatMessage(id: id, role: .assistant, parts: [])
            m.isStreaming = true
            messages.append(m)
        }
        guard let i = messages.firstIndex(where: { $0.id == id }) else { return }
        f(&messages[i])
    }

    private func date(_ v: JSONValue?) -> Date? { v?.double.map { Date(timeIntervalSince1970: $0 / 1000) } }

    static func failed(_ output: JSONValue?) -> Bool {
        guard let o = output else { return false }
        if o["success"]?.bool == false { return true }
        if let code = o["exitCode"]?.int, code != 0 { return true }
        return false
    }

    static func parseParts(_ parts: [JSONValue], messageId: String) -> [ChatPart] {
        var out: [ChatPart] = []
        for (i, p) in parts.enumerated() {
            switch p["type"]?.string {
            case "text":
                let t = p["text"]?.string ?? ""
                if case .text(let pid, let prev)? = out.last { out[out.count - 1] = .text(id: pid, prev + t) }
                else { out.append(.text(id: "\(messageId)-t\(i)", t)) }
            case "reasoning":
                out.append(.reasoning(id: "\(messageId)-r\(i)", p["text"]?.string ?? ""))
            case "dynamic-tool":
                let state = p["state"]?.string
                let output = p["output"]
                var t = ToolCall(id: p["toolCallId"]?.string ?? "\(messageId)-x\(i)", name: p["toolName"]?.string ?? "tool",
                                 input: p["input"] ?? .null, output: output,
                                 state: state == "output-available" ? .done : (state == "output-error" ? .failed : .running),
                                 startedAt: nil, endedAt: nil)
                if t.state == .done, failed(output) { t.state = .failed }
                if let ts = p["timestamp"]?.double { t.endedAt = Date(timeIntervalSince1970: ts / 1000) }
                out.append(.tool(t))
            default:
                break
            }
        }
        return out
    }

    // MARK: - Actions

    func send(_ text: String, model: String, agentId: String, thinking: ThinkingLevel?) async throws {
        var options: [String: JSONValue] = ["model": .string(model), "agentId": .string(agentId), "sendId": .string("ios-" + UUID().uuidString)]
        if let thinking { options["thinkingLevel"] = .string(thinking.rawValue) }
        try await client.call("workspace/sendMessage", ["workspaceId": .string(workspaceId), "message": .string(text), "options": .object(options)])
    }

    func interrupt() async throws {
        try await client.call("workspace/interruptStream", ["workspaceId": .string(workspaceId)])
    }

    func answer(_ q: PendingQuestion, answers: [String: String]) async throws {
        guard q.answerByMessage else { return try await answer(toolCallId: q.toolCallId, answers: answers) }
        let text = q.questions.map { "\($0.header.isEmpty ? $0.question : $0.header): \(answers[$0.question] ?? "Skipped")" }.joined(separator: "\n")
        let model = lastModel ?? "anthropic:claude-opus-5-5"
        let agent = messages.last(where: { $0.role == .assistant })?.agentId ?? "exec"
        answeredQuestionIds.insert(q.toolCallId)
        try await client.call("workspace/sendMessage", [
            "workspaceId": .string(workspaceId), "message": .string(text),
            "options": ["model": .string(model), "agentId": .string(agent), "sendId": .string("ios-" + UUID().uuidString),
                        "muxMetadata": ["type": "normal", "askUserQuestionAnswer": ["toolCallId": .string(q.toolCallId), "answers": .object(answers.mapValues { .string($0) })]]],
        ])
    }

    func answer(toolCallId: String, answers: [String: String]) async throws {
        try await client.call("workspace/answerAskUserQuestion", [
            "workspaceId": .string(workspaceId), "toolCallId": .string(toolCallId),
            "answers": .object(answers.mapValues { .string($0) }),
        ])
    }
}
