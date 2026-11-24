import Foundation
import Observation

/// One workspace composer's draft, kept the way the web client's DraftStore keeps it
/// (src/browser/stores/DraftStore.ts), so a phone send and a desktop send are the same operation:
///
/// - The text is the backend draft (`drafts.*`), shared with every other client of the server.
/// - A send is first recorded in the draft (`drafts.beginSend`, idempotent by send id), then sent
///   with `workspace.sendMessage`. That reply only answers when the turn ends and is never the
///   outcome: the backend's answer for the send id is (`drafts.resolveSends`, which asks
///   `workspace.getSendStatus`). Accepted drops the retained text, not accepted makes it visible
///   in the draft again, pending (queued, held, running) waits.
/// - An id is never looked up while its request is in flight: a lookup that reaches the receiver
///   first makes it refuse that send for good.
/// - An unknown answer (another backend process) moves the entry to the current receiver and
///   re-sends the same id with the same request; a failed lookup is retried. Bounded backoff.
@Observable
final class ComposerDraft {
    struct PendingSend: Hashable, Sendable {
        var sendId: String
        var receiverId: String
        var text: String
        var request: JSONValue
    }

    typealias Call = (String, JSONValue?) async throws -> JSONValue
    typealias Subscribe = (String) -> AsyncThrowingStream<JSONValue, Error>

    let workspaceId: String
    /// The visible text (without the text pending sends retain).
    private(set) var text = ""
    private(set) var pendingSends: [PendingSend] = []
    /// Sends whose last answer was unknown or a failed lookup: still being resolved.
    var unresolvedCount: Int { pendingSends.filter { isUnresolved($0.sendId) }.count }
    /// A send the backend did not accept, with its reason (its text is back in the composer).
    var onNotAccepted: ((String) -> Void)?

    static let retryLimit = 5
    static let writeDelay: Duration = .milliseconds(400)

    private let call: Call
    private let subscribeStream: Subscribe?
    private var scope: JSONValue { ["kind": "workspace", "workspaceId": .string(workspaceId)] }
    private var revision: Double = 0
    /// Bumped on every local edit; `savedEdit` is the edit the backend has.
    private var edit = 0
    private var savedEdit = 0
    private var writeTask: Task<Void, Never>?
    private var subscription: Task<Void, Never>?
    private var receiverId: String?
    private var issuing: Set<String> = []
    private var lookingUpReceiver = false
    /// The web's send mark (#6405): the text the last edit wrote while a send looks up its
    /// receiver, and whether every edit since the tap only appended to the sent text.
    private var sendMark: (last: String, intact: Bool)?
    private var resending: [String: String] = [:]
    private var lastStatus: [String: String] = [:]
    /// Answers for sends whose reply just came back, kept until their sender reads them (the
    /// draft view drops a resolved entry, and with it its `lastStatus`).
    private var settling: [String: String?] = [:]
    /// Sends whose draft write reply was lost: shown again here, possibly still held by the backend.
    private var undone: [String: PendingSend] = [:]
    private var resolving: Task<Void, Never>?
    private var rerun = false
    private var retryTask: Task<Void, Never>?
    private var retryAttempt = 0
    private var retriesStopped = false
    var retryDelay: (Int) -> Duration = { .milliseconds(min(1000 * (1 << $0), 16_000)) }

    init(workspaceId: String, call: @escaping Call, subscribe: Subscribe? = nil) {
        self.workspaceId = workspaceId
        self.call = call
        self.subscribeStream = subscribe
    }

    convenience init(workspaceId: String, client: APIClient) {
        self.init(workspaceId: workspaceId, call: { try await client.call($0, $1) },
                  subscribe: { client.subscribe($0) })
    }

    private var dirty: Bool { edit != savedEdit }

    // MARK: - Lifecycle

    func start() {
        guard subscription == nil, let subscribeStream else { return }
        subscription = Task { [weak self] in
            var backoff: UInt64 = 1
            while !Task.isCancelled {
                do {
                    guard let stream = self.map({ _ in subscribeStream("drafts/subscribe") }) else { return }
                    for try await ev in stream {
                        backoff = 1
                        self?.applyEvent(ev)
                    }
                } catch {
                    if Task.isCancelled { return }
                }
                try? await Task.sleep(nanoseconds: backoff * 1_000_000_000)
                backoff = min(backoff * 2, 15)
            }
        }
    }

    func stop() {
        subscription?.cancel()
        subscription = nil
        retryTask?.cancel()
        retryTask = nil
    }

    /// Reads the stored draft (also the pending sends a reload left) and resolves them.
    func load() async {
        do {
            let v = try await call("drafts/get", ["scope": scope])
            applyView(v)
        } catch {}
        triggerResolution(afterStop: true)
    }

    func applyEvent(_ ev: JSONValue) {
        switch ev["type"]?.string {
        case "snapshot":
            let mine = (ev["drafts"]?.array ?? []).first { $0["scope"]?["workspaceId"]?.string == workspaceId }
            if let mine { applyView(mine) } else { applyDeleted(revision: nil) }
        case "changed" where ev["scope"]?["workspaceId"]?.string == workspaceId:
            applyView(ev)
        case "deleted" where ev["scope"]?["workspaceId"]?.string == workspaceId:
            applyDeleted(revision: ev["revision"]?.double)
        default:
            break
        }
    }

    /// A server view of the draft. A newer revision replaces the pending sends; the text too,
    /// unless a local edit is not saved yet (the local write then wins, as on the web).
    private func applyView(_ v: JSONValue) {
        guard let r = v["revision"]?.double, r >= revision else { return }
        revision = r
        pendingSends = (v["pendingSends"]?.array ?? []).compactMap(Self.pendingSend)
        if !dirty { text = v["text"]?.string ?? "" }
        lastStatus = lastStatus.filter { id, _ in pendingSends.contains { $0.sendId == id } }
    }

    private func applyDeleted(revision r: Double?) {
        if let r { guard r >= revision else { return }; revision = r }
        pendingSends = []
        if !dirty { text = "" }
    }

    static func pendingSend(_ v: JSONValue) -> PendingSend? {
        guard let id = v["sendId"]?.string, let receiver = v["receiverId"]?.string, let request = v["request"] else { return nil }
        return PendingSend(sendId: id, receiverId: receiver, text: v["text"]?.string ?? "", request: request)
    }

    // MARK: - Typing

    func setText(_ new: String) {
        guard new != text else { return }
        if let m = sendMark { sendMark = (new, m.intact && text == m.last && new.hasPrefix(m.last)) }
        text = new
        edit += 1
        scheduleWrite()
    }

    /// Puts returned text in front of what the composer holds (the web's `restore` mode: a newer
    /// draft typed meanwhile survives).
    func restore(_ restored: String) {
        guard !restored.isEmpty else { return }
        setText(Self.join(restored, text))
    }

    static func join(_ a: String, _ b: String) -> String {
        a.isEmpty ? b : b.isEmpty ? a : a + "\n\n" + b
    }

    private func scheduleWrite() {
        writeTask?.cancel()
        writeTask = Task { [weak self] in
            try? await Task.sleep(for: Self.writeDelay)
            guard !Task.isCancelled else { return }
            await self?.flush()
        }
    }

    /// Writes the visible text now (a later edit schedules its own write).
    func flush() async {
        guard dirty else { return }
        let written = edit
        do {
            let v = try await call("drafts/update", ["scope": scope, "text": .string(text), "basisSends": basisSends])
            if edit == written { savedEdit = written }
            applyView(v)
        } catch {
            // Keep the change and try again, as the web store does.
            if edit == written { scheduleWrite() }
        }
    }

    /// The pending sends this composer's text was written against (BasisSendSchema).
    private var basisSends: JSONValue {
        var basis: [JSONValue] = pendingSends.map { ["sendId": .string($0.sendId), "text": .string($0.text), "attachmentIds": []] }
        for u in undone.values where !pendingSends.contains(where: { $0.sendId == u.sendId }) {
            basis.append(["sendId": .string(u.sendId), "text": .string(u.text), "attachmentIds": [], "undone": true])
        }
        return .array(basis)
    }

    // MARK: - Sending

    /// Takes `message` out of the composer and sends it. Returns once the draft holds the send
    /// (the composer is usable again at once); throws only when nothing was taken. Whether the
    /// backend accepted it arrives later through the draft, and `onNotAccepted` says why it did not.
    func send(message: String, options: [String: JSONValue]) async throws {
        // The receiver lookup comes before the text leaves the composer, so a second tap while it
        // runs would send the same text again under another id.
        guard !lookingUpReceiver else { return }
        lookingUpReceiver = true
        sendMark = (text, text == message)
        retriesStopped = false
        retryAttempt = 0
        let receiver: String
        do {
            receiver = try await currentReceiver()
        } catch {
            lookingUpReceiver = false
            sendMark = nil
            throw error
        }
        lookingUpReceiver = false
        // Keys typed during the lookup follow the sent text: take exactly that prefix, and let
        // the backend repeat that take (localTake) instead of its whitespace rule, which cannot
        // split `hello` from `hellonext`.
        let typedAfter = sendMark.map { $0.intact && $0.last == text } ?? false
        sendMark = nil
        let sendId = UUID().uuidString.lowercased()
        var request: [String: JSONValue] = options
        request.removeValue(forKey: "sendId")
        let pending = PendingSend(sendId: sendId, receiverId: receiver, text: message,
                                  request: ["message": .string(message), "options": .object(request)])
        let visible = text
        writeTask?.cancel()
        issuing.insert(sendId)
        // The composer shows what the user types from here on; the draft write takes the sent text.
        let after = typedAfter ? String(visible.dropFirst(message.count)) : ""
        text = after
        edit += 1
        let taken = edit
        var body: [String: JSONValue] = [
            "scope": scope,
            "pendingSend": ["sendId": .string(sendId), "receiverId": .string(receiver), "text": .string(message),
                            "attachmentIds": [], "request": pending.request],
            "attachments": [],
            "text": .string(visible),
            "basisSends": basisSends,
        ]
        if typedAfter { body["localTake"] = ["kind": "typed-after"] }
        do {
            let v = try await call("drafts/beginSend", .object(body))
            if edit == taken { savedEdit = taken }
            applyView(v)
            if dirty { scheduleWrite() }
        } catch {
            issuing.remove(sendId)
            // The write may have landed with its reply lost: show the text again, and let the
            // next write and lookup settle the entry the backend may hold.
            undone[sendId] = pending
            // Keys typed after the take still follow the sent text.
            text = !after.isEmpty && text.hasPrefix(after) ? message + text : Self.join(visible, text)
            edit += 1
            scheduleWrite()
            throw error
        }
        Task { [weak self] in await self?.issue(pending) }
    }

    private func issue(_ send: PendingSend) async {
        var reply: String?
        do {
            _ = try await call("workspace/sendMessage", sendMessageBody(send))
        } catch {
            reply = error.localizedDescription
        }
        issuing.remove(send.sendId)
        settling[send.sendId] = .some(nil)
        await resolve()
        let status = settling.removeValue(forKey: send.sendId) ?? nil
        if status == "not-accepted" {
            onNotAccepted?(reply ?? "The server did not take the message.")
        }
    }

    private func sendMessageBody(_ send: PendingSend) -> JSONValue {
        var options = send.request["options"]?.object ?? [:]
        options["sendId"] = .string(send.sendId)
        return ["workspaceId": .string(workspaceId), "message": send.request["message"] ?? .string(send.text), "options": .object(options)]
    }

    /// The backend process this connection reaches (an empty getSendStatus lookup).
    private func currentReceiver() async throws -> String {
        if let receiverId { return receiverId }
        let v = try await call("workspace/getSendStatus", ["workspaceId": .string(workspaceId), "sendIds": []])
        guard let id = v["data"]?["receiverId"]?.string ?? v["receiverId"]?.string else { throw APIError.decoding }
        receiverId = id
        return id
    }

    /// Whether this composer still retains the send (a restore must not insert it again).
    func retains(_ sendId: String) -> Bool {
        issuing.contains(sendId) || pendingSends.contains { $0.sendId == sendId }
    }

    private func isUnresolved(_ id: String) -> Bool {
        !issuing.contains(id) && (lastStatus[id] == "unknown" || lastStatus[id] == "failed")
    }

    // MARK: - Resolution

    /// Load, reconnect or a new send after Stop re-arm the retries; chat events only look up.
    func triggerResolution(afterStop: Bool = false) {
        if !retriesStopped || afterStop {
            retriesStopped = false
            retryAttempt = 0
        }
        Task { await resolve() }
    }

    /// A chat event that can change a send's status. A user row triggers only for a send pending here.
    func onSendEvent(rowSendIds: [String]? = nil) {
        guard !pendingSends.isEmpty || !undone.isEmpty else { return }
        if let rowSendIds, !pendingSends.contains(where: { rowSendIds.contains($0.sendId) }) { return }
        triggerResolution()
    }

    /// The queue holds these ids, so their requests arrived: a lookup can no longer get ahead of them.
    func onQueuedSends(_ ids: [String]) {
        for id in ids { issuing.remove(id) }
        onSendEvent()
    }

    /// One resolution at a time; a trigger during one runs another right after.
    func resolve() async {
        if let resolving {
            rerun = true
            await resolving.value
            if let next = self.resolving { await next.value }
            return
        }
        let t = Task { [weak self] in
            guard let self else { return }
            repeat {
                rerun = false
                await resolveOnce()
            } while rerun
        }
        resolving = t
        await t.value
        resolving = nil
    }

    private func resolveOnce() async {
        let candidates = pendingSends.filter { !issuing.contains($0.sendId) }
        let undoneIds = undone.keys.filter { !issuing.contains($0) }
        guard !candidates.isEmpty || !undoneIds.isEmpty else { return }
        do {
            let v = try await call("drafts/resolveSends", ["scope": scope, "exceptSendIds": .array(issuing.map { .string($0) })])
            if let r = v["receiverId"]?.string { receiverId = r }
            for s in v["statuses"]?.array ?? [] {
                guard let id = s["sendId"]?.string, let status = s["status"]?.string else { continue }
                lastStatus[id] = status
                if settling[id] != nil { settling[id] = .some(status) }
                if status != "unknown" { undone.removeValue(forKey: id) }
            }
        } catch {
            for c in candidates { lastStatus[c.sendId] = "failed" }
        }
        // The backend applied the answers to the draft: read it (the subscription may lag).
        if let v = try? await call("drafts/get", ["scope": scope]) { applyView(v) }
        scheduleRetry()
    }

    private func scheduleRetry() {
        guard retryTask == nil, !retriesStopped, retryAttempt < Self.retryLimit else { return }
        guard pendingSends.contains(where: { isUnresolved($0.sendId) }) else { return }
        let delay = retryDelay(retryAttempt)
        retryAttempt += 1
        retryTask = Task { [weak self] in
            try? await Task.sleep(for: delay)
            guard let self, !Task.isCancelled else { return }
            retryTask = nil
            await retrySends()
        }
    }

    private func retrySends() async {
        for send in pendingSends where isUnresolved(send.sendId) && lastStatus[send.sendId] == "unknown" {
            if retriesStopped { return }
            do {
                let receiver = try await currentReceiver()
                if send.receiverId != receiver {
                    // The draft write first: a lookup after the re-send must ask the receiver it went to.
                    let moved = try await call("drafts/setSendReceiver", ["scope": scope, "sendId": .string(send.sendId), "receiverId": .string(receiver)])
                    if moved["present"]?.bool == false { continue }
                }
                // Never sent (lost draft-write reply): moving it is enough, the lookup refuses it.
                if undone[send.sendId] != nil { continue }
                issuing.insert(send.sendId)
                resending[send.sendId] = receiver
                defer {
                    issuing.remove(send.sendId)
                    resending.removeValue(forKey: send.sendId)
                }
                _ = try? await call("workspace/sendMessage", sendMessageBody(send))
            } catch {
                // The lookup below decides what happened to it.
            }
        }
        if !retriesStopped { await resolve() }
    }

    /// Stop: no automatic re-send or lookup until the next load, reconnect or send. A re-send
    /// already on its way is looked up at its receiver before the interrupt goes out: one that has
    /// not arrived is refused for good, one that has is where the interrupt reaches it.
    func abortRetries() async {
        retriesStopped = true
        retryTask?.cancel()
        retryTask = nil
        for (id, receiver) in resending {
            _ = try? await call("workspace/getSendStatus", ["workspaceId": .string(workspaceId), "sendIds": [.string(id)], "receiverId": .string(receiver)])
        }
    }
}
