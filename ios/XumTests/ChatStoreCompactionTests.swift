import Foundation
import Testing
@testable import Xum

@MainActor
struct ChatStoreCompactionTests {
    private func store() -> ChatStore {
        ChatStore(workspaceId: "ws", client: APIClient(baseURL: URL(string: "http://127.0.0.1:1")!, token: "t"))
    }

    private func row(_ id: String, role: String, seq: Int, text: String, metadata: [String: JSONValue] = [:]) -> JSONValue {
        var meta = metadata
        meta["historySequence"] = .number(Double(seq))
        return ["type": "message", "id": .string(id), "role": .string(role),
                "parts": [["type": "text", "text": .string(text)]], "metadata": .object(meta)]
    }

    @Test func replayFromBoundaryMarksSummaryAndOlderHistory() {
        let s = store()
        s.apply(row("sum", role: "assistant", seq: 3, text: "Summary",
                    metadata: ["compacted": "idle", "muxMetadata": ["type": "compaction-summary"]]))
        s.apply(["type": "caught-up", "historyReplayStatus": "complete"])
        #expect(s.messages.first?.compaction == .summary(source: "idle"))
        #expect(s.hasOlder)
    }

    @Test func fullHistoryHasNoOlderRows() {
        let s = store()
        s.apply(row("u", role: "user", seq: 0, text: "Hi"))
        s.apply(["type": "caught-up", "historyReplayStatus": "complete"])
        #expect(!s.hasOlder)
        #expect(s.messages.first?.compaction == nil)
    }

    @Test func syntheticCompactionRequestShowsAsCommandMarker() {
        let s = store()
        s.apply(row("req", role: "user", seq: 2, text: "Summarize this conversation…",
                    metadata: ["synthetic": true, "muxMetadata": ["type": "compaction-request", "rawCommand": "/compact -t 2000\nContinue"]]))
        #expect(s.messages.first?.compaction == .request(command: "/compact -t 2000"))
    }

    @Test func compactAgentStreamIsALiveSummary() {
        let s = store()
        s.apply(["type": "auto-compaction-triggered"])
        s.apply(["type": "stream-start", "messageId": "m", "agentId": "compact", "model": "x"])
        #expect(s.messages.first?.compaction == .summary(source: "auto"))
        #expect(s.messages.first?.isStreaming == true)
    }
}
