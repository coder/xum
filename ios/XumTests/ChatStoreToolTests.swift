import Foundation
import Testing
@testable import Xum

@MainActor
struct ChatStoreToolTests {
    private func store() -> ChatStore {
        ChatStore(workspaceId: "ws", client: APIClient(baseURL: URL(string: "http://127.0.0.1:1")!, token: "t"))
    }

    private func tool(_ id: String, state: String, at ms: Double, extra: [String: JSONValue] = [:]) -> JSONValue {
        var p: [String: JSONValue] = ["type": "dynamic-tool", "toolCallId": .string(id), "toolName": "bash",
                                      "input": [:], "state": .string(state), "timestamp": .number(ms)]
        p.merge(extra) { $1 }
        return .object(p)
    }

    private func tools(_ parts: [ChatPart]) -> [ToolCall] {
        parts.compactMap { if case .tool(let t) = $0 { t } else { nil } }
    }

    @Test func redactedToolsAreFinished() {
        let t = tools(ChatStore.parseParts([
            tool("a", state: "output-redacted", at: 1000),
            tool("b", state: "output-redacted", at: 2000, extra: ["failed": true]),
        ], messageId: "m"))
        #expect(t.map(\.state) == [.done, .failed])
    }

    @Test func persistedToolEndsWhenTheNextCallWasEmitted() {
        let t = tools(ChatStore.parseParts([
            tool("a", state: "output-available", at: 1000, extra: ["executionStartedAt": 4000, "output": ["success": true]]),
            tool("b", state: "output-available", at: 9000, extra: ["output": ["success": true]]),
        ], messageId: "m"))
        #expect(t[0].duration == 5)
        // The last call has no later call, so its end time and duration are unknown.
        #expect(t[1].duration == nil)
    }

    @Test func liveTimerStartsAtExecution() {
        let s = store()
        s.apply(["type": "stream-start", "messageId": "m", "model": "x", "startTime": 0, "historySequence": 1])
        s.apply(["type": "tool-call-start", "messageId": "m", "toolCallId": "a", "toolName": "bash", "args": [:], "timestamp": 1000])
        #expect(s.messages.first?.tools.first?.startedAt == nil)
        s.apply(["type": "tool-call-execution-start", "messageId": "m", "toolCallId": "a", "timestamp": 6000])
        #expect(s.messages.first?.tools.first?.startedAt == Date(timeIntervalSince1970: 6))
    }

    private func question(_ id: String, byMessage: Bool) -> JSONValue {
        var p: [String: JSONValue] = ["type": "dynamic-tool", "toolCallId": .string(id), "toolName": "ask_user_question",
                                      "input": ["questions": [["question": "Pick", "options": [["label": "A"]]]]]]
        if byMessage {
            p["state"] = "output-available"
            p["output"] = ["ui_only": ["ask_user_question": ["answerDelivery": "message"]]]
        } else {
            p["state"] = "input-available"
        }
        return .object(p)
    }

    private func row(_ id: String, role: String, seq: Int, parts: [JSONValue]) -> JSONValue {
        ["type": "message", "id": .string(id), "role": .string(role), "parts": .array(parts),
         "metadata": ["historySequence": .number(Double(seq))]]
    }

    @Test(arguments: [(true, true), (false, false)])
    func unrelatedUserRowEndsOnlyBlockingQuestions(byMessage: Bool, stillOpen: Bool) {
        let s = store()
        s.apply(row("q", role: "assistant", seq: 1, parts: [question("ask", byMessage: byMessage)]))
        s.apply(row("u", role: "user", seq: 2, parts: [["type": "text", "text": "unrelated"]]))
        s.apply(["type": "caught-up", "historyReplayStatus": "complete"])
        #expect((s.pendingQuestion != nil) == stillOpen)
    }
}

@MainActor
struct SandboxApprovalTests {
    @Test func pendingApprovalShowsUntilAnsweredOrEnded() {
        let s = ChatStore(workspaceId: "ws", client: APIClient(baseURL: URL(string: "http://127.0.0.1:1")!, token: "t"))
        s.apply(["type": "bash-sandbox-approval", "toolCallId": "a", "script": "curl x", "reason": "network", "pending": true, "timestamp": 1])
        #expect(s.sandboxApprovals.map(\.toolCallId) == ["a"])
        s.apply(["type": "bash-sandbox-approval", "toolCallId": "a", "script": "curl x", "reason": "network", "pending": false, "timestamp": 2])
        #expect(s.sandboxApprovals.isEmpty)
        s.apply(["type": "bash-sandbox-approval", "toolCallId": "b", "script": "ls", "reason": "r", "pending": true, "timestamp": 3])
        s.apply(["type": "tool-call-end", "messageId": "m", "toolCallId": "b", "result": [:], "timestamp": 4])
        #expect(s.sandboxApprovals.isEmpty)
    }
}

struct ChangesParserTests {
    @Test func pathsWithTabsNewlinesAndRenamesSurvive() {
        let out = "BASE f7da711ca4\u{0}3\t1\tsrc/a.ts\u{0}2\t0\t\u{0}old name.ts\u{0}new\tname.ts\u{0}-\t-\tlogo.png\u{0}UNTRACKED\u{0}1\u{0}tab\tnl\nname.txt\u{0}"
        let (base, files) = WorkspaceInfoStore.parseChanges(out)
        #expect(base == "f7da711c")
        #expect(files.map(\.path) == ["src/a.ts", "new\tname.ts", "logo.png", "tab\tnl\nname.txt"])
        #expect(files.map(\.added) == [3, 2, 0, 1])
        #expect(files.map(\.untracked) == [false, false, false, true])
    }
}

struct APIResultErrorTests {
    @Test(arguments: [
        (JSONValue.string("nope"), "nope"),
        (JSONValue.object(["type": "invalid", "message": "Bad input"]), "Bad input"),
        (JSONValue.object(["type": "unknown", "raw": "Workspace not found"]), "Workspace not found"),
        (JSONValue.object(["type": "api_key_not_found", "provider": "anthropic"]), "api key not found: anthropic"),
    ] as [(JSONValue, String)])
    func readsStringOrObjectErrors(error: JSONValue, message: String) {
        #expect(APIClient.resultError(error) == message)
    }
}
