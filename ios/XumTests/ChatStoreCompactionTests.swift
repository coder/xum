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

    @Test func failedReplayIsNotCaughtUp() {
        let s = store()
        s.apply(row("u", role: "user", seq: 4, text: "Hi"))
        s.apply(["type": "caught-up", "historyReplayStatus": "failed"])
        #expect(!s.caughtUp)
        #expect(s.replayFailed)
        #expect(!s.hasOlder)
    }

    @Test func attachmentOnlyMessageKeepsItsFiles() {
        let s = store()
        s.apply(["type": "message", "id": "u", "role": "user", "metadata": ["historySequence": 0],
                 "parts": [["type": "file", "url": "data:image/png;base64,AA", "mediaType": "image/png", "filename": "shot.png"],
                           ["type": "file", "url": "data:text/plain;base64,AA", "mediaType": "text/plain"]]])
        #expect(s.messages.first?.files == [AttachedFile(name: "shot.png", mediaType: "image/png"), AttachedFile(name: "File", mediaType: "text/plain")])
    }
}

struct ConnectionLinkTransportTests {
    @Test(arguments: [
        ("https://devbox.example.com/?token=t", true),
        ("http://127.0.0.1:3000/?token=t", true),
        ("http://localhost:3000/?token=t", true),
        ("http://100.100.16.68:3000/?token=t", false),
        ("http://devbox.tail4e2c.ts.net:3000/?token=t", false),
        ("http://192.168.1.20:3000/?token=t", false),
        ("http://devbox.local:3000/?token=t", false),
        ("http://127.attacker.example:3000/?token=t", false),
        ("http://[::1]:3000/?token=t", true),
        ("http://[fd7a:115c:a1e0::1]:3000/?token=t", false),
    ])
    func protectedTransport(link: String, protected: Bool) throws {
        let parsed = try #require(ConnectionLink.parse(link))
        #expect(parsed.isProtectedTransport == protected)
    }

    @Test func urlStringRoundTrips() throws {
        let link = try #require(ConnectionLink.parse("http://10.0.0.2:3000/proxy/?token=a%2Bb%2Fc"))
        #expect(ConnectionLink.parse(link.urlString) == link)
    }
}
