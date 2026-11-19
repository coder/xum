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

    /// Nil for a finished call whose end time is unknown (persisted parts carry no end time).
    var duration: TimeInterval? {
        guard let s = startedAt, state == .running || endedAt != nil else { return nil }
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

/// Compaction rows: the `/compact` request (a user row whose text is the long summarization
/// prompt) and the summary that replaces the history before it.
enum CompactionKind: Hashable, Sendable {
    case request(command: String)
    /// `source` is the server's `compacted` value: "user", "idle", "heartbeat" (or "auto").
    case summary(source: String)
}

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
    var compaction: CompactionKind?

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

/// A bash call the sandbox blocked, waiting for the user to let it run once outside
/// (`bash-sandbox-approval`, answered with `workspace.answerSandboxApproval`).
struct SandboxApproval: Hashable, Sendable {
    var toolCallId: String
    var script: String
    var reason: String
}

/// Input the server returned instead of running it (Stop with a queued follow-up, a refused
/// queued send): `held-inputs-changed` lists it until a composer takes or discards it.
struct HeldInput: Hashable, Sendable {
    var id: String
    var text: String
}

/// A one-shot `restore-to-input`; `seq` tells repeated restores of the same text apart.
struct RestoredInput: Equatable, Sendable {
    var seq: Int
    var text: String
    var heldInputIds: [String]
    /// Attachments and review notes cannot be put back in this composer, so such an input stays held.
    var textOnly: Bool
}

/// One workspace's chat: replays `workspace.onChat` (full) then applies live events, mirroring the
/// web client's StreamingMessageAggregator closely enough for the phone UI. Unknown events are
/// ignored so newer servers never break the app.
@Observable
final class ChatStore {
    let workspaceId: String
    private(set) var messages: [ChatMessage] = []
    private(set) var caughtUp = false
    /// The server ended the replay with `historyReplayStatus: "failed"`: the rows are incomplete.
    private(set) var replayFailed = false
    private(set) var streamingMessageId: String?
    private(set) var lastError: String?
    private(set) var contextTokens: Int?
    private(set) var hasQueued = false
    /// Rows exist before the oldest loaded one (an earlier compaction epoch).
    private(set) var hasOlder = false
    private(set) var loadingOlder = false
    private(set) var autoCompacting = false
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

    private(set) var sandboxApprovals: [SandboxApproval] = []
    private(set) var heldInputs: [HeldInput] = []
    private(set) var restoredInput: RestoredInput?
    private var restoreSeq = 0

    /// Tool call IDs answered by a later user message (`muxMetadata.askUserQuestionAnswer`).
    private(set) var answeredQuestionIds: Set<String> = []

    /// The newest open question. A later user row ends a blocking question's turn, but a
    /// message-delivered question stays open until a message carries its answer, so answering
    /// one moves on to the next open one.
    var pendingQuestion: PendingQuestion? {
        var laterUserRow = false
        for m in messages.reversed() {
            if m.role == .user { laterUserRow = true; continue }
            for t in m.tools.reversed() where t.name == "ask_user_question" {
                guard let q = PendingQuestion(tool: t), !answeredQuestionIds.contains(q.toolCallId) else { continue }
                if laterUserRow && !q.answerByMessage { continue }
                return q
            }
        }
        return nil
    }

    /// The last proposed plan, when it is the newest assistant output (so the card shows Implement).
    var latestPlanToolId: String? {
        guard let last = messages.last(where: { $0.role == .assistant }) else { return nil }
        // A failed call saved no plan, so there is nothing to implement.
        guard let plan = last.tools.last(where: { $0.name == "propose_plan" }), plan.state == .done else { return nil }
        return plan.id
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
                    if replayFailed { break }
                }
                // A failed replay leaves partial history, so resubscribe instead of showing it.
                if replayFailed { connectionError = "The server could not load this chat's history." }
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
        sandboxApprovals = []
        heldInputs = []
        caughtUp = false
        replayFailed = false
        hasOlder = false
        autoCompacting = false
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
            if ev["historyReplayStatus"]?.string == "failed" {
                replayFailed = true
                return
            }
            caughtUp = true
            // Servers send hasOlderHistory only to windowed clients; otherwise the replay holds
            // the active epoch, and rows before a compaction boundary are older pages.
            if let older = ev["hasOlderHistory"]?.bool {
                hasOlder = older
            } else if let first = messages.first {
                hasOlder = (first.historySequence ?? 0) > 0
            }
        case "auto-compaction-triggered":
            autoCompacting = true
        case "auto-compaction-completed":
            autoCompacting = false
        case "stream-start":
            guard let id = ev["messageId"]?.string else { return }
            var m = ChatMessage(id: id, role: .assistant, parts: [], model: ev["model"]?.string, agentId: ev["agentId"]?.string,
                                timestamp: date(ev["startTime"]), historySequence: ev["historySequence"]?.int)
            m.isStreaming = true
            if m.agentId == "compact" || ev["mode"]?.string == "compact" {
                m.compaction = .summary(source: autoCompacting ? "auto" : "user")
            }
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
                // `timestamp` is when the model emitted the call; parallel calls run one at a time,
                // so the timer starts at execution (here on replay, else tool-call-execution-start).
                let t = ToolCall(id: tid, name: ev["toolName"]?.string ?? "tool", input: ev["args"] ?? .null, output: nil,
                                 state: .running, startedAt: date(ev["executionStartedAt"]), endedAt: nil)
                if let i = m.parts.firstIndex(where: { $0.id == tid }) { m.parts[i] = .tool(t) } else { m.parts.append(.tool(t)) }
            }
        case "tool-call-execution-start":
            mutate(ev["messageId"]?.string) { m in
                guard let tid = ev["toolCallId"]?.string, let i = m.parts.firstIndex(where: { $0.id == tid }),
                      case .tool(var t) = m.parts[i] else { return }
                t.startedAt = date(ev["timestamp"]) ?? Date()
                m.parts[i] = .tool(t)
            }
        case "tool-call-end":
            if let tid = ev["toolCallId"]?.string { sandboxApprovals.removeAll { $0.toolCallId == tid } }
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
                if let parts = ev["parts"]?.array {
                    // Keep the end times measured live; the persisted parts have none.
                    var live: [String: ToolCall] = [:]
                    for case .tool(let t) in m.parts { live[t.id] = t }
                    m.parts = Self.parseParts(parts, messageId: m.id).map { p in
                        guard case .tool(var t) = p, let l = live[t.id], l.endedAt != nil else { return p }
                        t.startedAt = l.startedAt ?? t.startedAt
                        t.endedAt = l.endedAt
                        return .tool(t)
                    }
                }
                m.isStreaming = false
                m.model = ev["metadata"]?["model"]?.string ?? m.model
                if let ctx = ev["metadata"]?["contextUsage"]?["inputTokens"]?.int { contextTokens = ctx }
                if m.reasoningStartedAt != nil, m.reasoningEndedAt == nil { m.reasoningEndedAt = Date() }
            }
            if streamingMessageId == ev["messageId"]?.string { streamingMessageId = nil }
        case "restore-to-input":
            restoreSeq += 1
            restoredInput = RestoredInput(seq: restoreSeq, text: ev["text"]?.string ?? "",
                                          heldInputIds: (ev["heldInputIds"]?.array ?? []).compactMap(\.string),
                                          textOnly: (ev["fileParts"]?.array ?? []).isEmpty && (ev["reviews"]?.array ?? []).isEmpty)
        case "held-inputs-changed":
            heldInputs = (ev["heldInputs"]?.array ?? []).compactMap { h in
                guard let id = h["id"]?.string else { return nil }
                return HeldInput(id: id, text: h["displayText"]?.string ?? "")
            }
        case "bash-sandbox-approval":
            guard let tid = ev["toolCallId"]?.string else { return }
            sandboxApprovals.removeAll { $0.toolCallId == tid }
            if ev["pending"]?.bool == true {
                sandboxApprovals.append(SandboxApproval(toolCallId: tid, script: ev["script"]?.string ?? "", reason: ev["reason"]?.string ?? ""))
            }
        case "stream-abort":
            sandboxApprovals = []
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
        guard let m = persistedMessage(ev) else { return }
        if m.parts.isEmpty, m.role == .assistant, messages.contains(where: { $0.id == m.id }) { return }
        var merged = m
        if let existing = messages.first(where: { $0.id == m.id }) {
            merged.isStreaming = existing.isStreaming && streamingMessageId == m.id
            merged.reasoningStartedAt = existing.reasoningStartedAt
            merged.reasoningEndedAt = existing.reasoningEndedAt
        }
        upsert(merged)
    }

    /// One persisted history row as a chat message; nil for rows the UI hides.
    private func persistedMessage(_ ev: JSONValue) -> ChatMessage? {
        guard let id = ev["id"]?.string, let roleS = ev["role"]?.string else { return nil }
        let meta = ev["metadata"]
        // Synthetic user rows (TODO nudges, system notifications) are not shown unless the server
        // marks them visible, matching the web UI.
        let muxType = meta?["muxMetadata"]?["type"]?.string
        let isCompactionRequest = roleS == "user" && muxType == "compaction-request"
        if roleS == "user", !isCompactionRequest, meta?["synthetic"]?.bool == true, meta?["uiVisible"]?.bool != true { return nil }
        if roleS == "user", let t = ev["parts"]?[0]?["text"]?.string, t.hasPrefix("<notification>") { return nil }
        if let a = meta?["muxMetadata"]?["askUserQuestionAnswer"] {
            for e in a.array ?? [a] { if let id = e["toolCallId"]?.string { answeredQuestionIds.insert(id) } }
        }
        let role = ChatRole(rawValue: roleS) ?? .system
        guard role != .system else { return nil }
        var m = ChatMessage(id: id, role: role, parts: Self.parseParts(ev["parts"]?.array ?? [], messageId: id),
                            model: meta?["model"]?.string, agentId: meta?["agentId"]?.string,
                            timestamp: date(meta?["timestamp"]), historySequence: meta?["historySequence"]?.int)
        if role == .assistant, let ctx = meta?["contextUsage"]?["inputTokens"]?.int { contextTokens = ctx }
        if isCompactionRequest {
            let raw = meta?["muxMetadata"]?["commandPrefix"]?.string ?? meta?["muxMetadata"]?["rawCommand"]?.string
            m.compaction = .request(command: raw.map(ChatFormat.firstLine) ?? "/compact")
        } else if role == .assistant, let c = meta?["compacted"], c.bool != false, !c.isNull {
            m.compaction = .summary(source: c.string ?? "user")
        } else if role == .assistant, muxType == "compaction-summary" {
            m.compaction = .summary(source: "user")
        }
        return m
    }

    /// Prepends the page of history before the oldest loaded row (`workspace.history.loadMore`).
    func loadOlder() async {
        guard hasOlder, !loadingOlder, let first = messages.first, let seq = first.historySequence else { return }
        loadingOlder = true
        defer { loadingOlder = false }
        do {
            let res = try await client.call("workspace/history/loadMore", [
                "workspaceId": .string(workspaceId),
                "cursor": ["beforeHistorySequence": .number(Double(seq)), "beforeMessageId": .string(first.id)],
            ])
            let known = Set(messages.map(\.id))
            let older = (res["messages"]?.array ?? []).compactMap(persistedMessage).filter { !known.contains($0.id) }
            messages.insert(contentsOf: older, at: 0)
            hasOlder = res["hasOlder"]?.bool ?? false
        } catch {
            lastError = error.localizedDescription
        }
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

    private func date(_ v: JSONValue?) -> Date? { Self.date(v) }
    private static func date(_ v: JSONValue?) -> Date? { v?.double.map { Date(timeIntervalSince1970: $0 / 1000) } }

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
                // `output-redacted` is terminal too: its output was dropped and `failed` keeps the outcome.
                let failedCall = state == "output-redacted" ? p["failed"]?.bool == true : failed(output)
                let t = ToolCall(id: p["toolCallId"]?.string ?? "\(messageId)-x\(i)", name: p["toolName"]?.string ?? "tool",
                                 input: p["input"] ?? .null, output: output,
                                 state: state == "output-available" || state == "output-redacted" ? (failedCall ? .failed : .done) : .running,
                                 startedAt: date(p["executionStartedAt"]) ?? date(p["timestamp"]), endedAt: nil)
                // A persisted part has no end time; the next call the model emitted came after this result.
                if let prev = out.lastIndex(where: { if case .tool = $0 { true } else { false } }),
                   case .tool(var pt) = out[prev], pt.state != .running, pt.endedAt == nil,
                   let s = pt.startedAt, let next = date(p["timestamp"]), next >= s {
                    pt.endedAt = next
                    out[prev] = .tool(pt)
                }
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
        do {
            try await client.call("workspace/sendMessage", ["workspaceId": .string(workspaceId), "message": .string(text), "options": .object(options)])
        } catch {
            lastError = "Message not sent: \(error.localizedDescription)"
            throw error
        }
    }

    func report(_ error: String) { lastError = error }

    func takeRestoredInput() -> RestoredInput? {
        defer { restoredInput = nil }
        return restoredInput
    }

    /// Tells the server the composer took these inputs, so they stop being held.
    func discardHeld(_ ids: [String]) async {
        for id in ids {
            do {
                try await client.call("workspace/discardHeldInput", ["workspaceId": .string(workspaceId), "heldInputId": .string(id)])
                heldInputs.removeAll { $0.id == id }
            } catch {
                lastError = "Could not clear a returned message: \(error.localizedDescription)"
            }
        }
    }

    func answerSandbox(_ approval: SandboxApproval, approved: Bool) async throws {
        do {
            try await client.call("workspace/answerSandboxApproval", [
                "workspaceId": .string(workspaceId), "toolCallId": .string(approval.toolCallId), "approved": .bool(approved),
            ])
            sandboxApprovals.removeAll { $0.toolCallId == approval.toolCallId }
        } catch {
            lastError = "Answer not sent: \(error.localizedDescription)"
            throw error
        }
    }

    func interrupt() async throws {
        do {
            try await client.call("workspace/interruptStream", ["workspaceId": .string(workspaceId)])
        } catch {
            lastError = "Could not stop: \(error.localizedDescription)"
            throw error
        }
    }

    func answer(_ q: PendingQuestion, answers: [String: String]) async throws {
        guard q.answerByMessage else { return try await answer(toolCallId: q.toolCallId, answers: answers) }
        let text = q.questions.map { "\($0.header.isEmpty ? $0.question : $0.header): \(answers[$0.question] ?? "Skipped")" }.joined(separator: "\n")
        let model = lastModel ?? "anthropic:claude-opus-5-5"
        let agent = messages.last(where: { $0.role == .assistant })?.agentId ?? "exec"
        answeredQuestionIds.insert(q.toolCallId)
        do {
            try await client.call("workspace/sendMessage", [
                "workspaceId": .string(workspaceId), "message": .string(text),
                "options": ["model": .string(model), "agentId": .string(agent), "sendId": .string("ios-" + UUID().uuidString),
                            "muxMetadata": ["type": "normal", "askUserQuestionAnswer": ["toolCallId": .string(q.toolCallId), "answers": .object(answers.mapValues { .string($0) })]]],
            ])
        } catch {
            answeredQuestionIds.remove(q.toolCallId)
            lastError = "Answer not sent: \(error.localizedDescription)"
            throw error
        }
    }

    func answer(toolCallId: String, answers: [String: String]) async throws {
        do {
            try await client.call("workspace/answerAskUserQuestion", [
                "workspaceId": .string(workspaceId), "toolCallId": .string(toolCallId),
                "answers": .object(answers.mapValues { .string($0) }),
            ])
        } catch {
            lastError = "Answer not sent: \(error.localizedDescription)"
            throw error
        }
    }
}
