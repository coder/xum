import Foundation
import Observation

struct ServerRecord: Codable, Identifiable, Hashable, Sendable {
    var id: String
    var name: String
    var baseURL: URL
    var tokenLast4: String
    var addedAt: Date
    var lastVersion: String?

    /// `devbox.tail4e2c.ts.net:3000`
    var hostLabel: String {
        let h = baseURL.host() ?? baseURL.absoluteString
        if let p = baseURL.port { return "\(h):\(p)" }
        return h
    }
}

enum ServerReachability: Equatable, Sendable {
    case unknown
    case checking
    case online(latencyMs: Int, version: String)
    case unauthorized
    case offline(since: Date)
}

/// Saved servers (JSON in Application Support; tokens only in Keychain) and the current one.
@Observable
final class ServerStore {
    private(set) var servers: [ServerRecord] = []
    var currentID: String? {
        didSet { UserDefaults.standard.set(currentID, forKey: "xum.currentServer") }
    }
    var reachability: [String: ServerReachability] = [:]

    private let fileURL: URL

    init(fileURL: URL? = nil) {
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        self.fileURL = fileURL ?? dir.appending(path: "servers.json")
        if let d = try? Data(contentsOf: self.fileURL), let s = try? JSONDecoder().decode([ServerRecord].self, from: d) {
            servers = s
        }
        let saved = UserDefaults.standard.string(forKey: "xum.currentServer")
        currentID = servers.contains(where: { $0.id == saved }) ? saved : servers.first?.id
    }

    var current: ServerRecord? { servers.first { $0.id == currentID } }

    func client(for server: ServerRecord) -> APIClient? {
        guard let t = Keychain.token(for: server.id) else { return nil }
        return APIClient(baseURL: server.baseURL, token: t)
    }

    var currentClient: APIClient? { current.flatMap(client(for:)) }

    /// Adds (or updates, matching on base URL) a server and makes it current.
    @discardableResult
    func add(link: ConnectionLink, name: String, version: String?) -> ServerRecord {
        if let i = servers.firstIndex(where: { $0.baseURL == link.baseURL }) {
            servers[i].name = name
            servers[i].tokenLast4 = link.tokenLast4
            servers[i].lastVersion = version ?? servers[i].lastVersion
            Keychain.save(token: link.token, for: servers[i].id)
            currentID = servers[i].id
            persist()
            return servers[i]
        }
        let rec = ServerRecord(id: UUID().uuidString, name: name, baseURL: link.baseURL, tokenLast4: link.tokenLast4, addedAt: Date(), lastVersion: version)
        Keychain.save(token: link.token, for: rec.id)
        servers.append(rec)
        currentID = rec.id
        persist()
        return rec
    }

    func rename(_ id: String, to name: String) {
        guard let i = servers.firstIndex(where: { $0.id == id }) else { return }
        servers[i].name = name
        persist()
    }

    func forget(_ id: String) {
        Keychain.delete(id: id)
        servers.removeAll { $0.id == id }
        reachability[id] = nil
        if currentID == id { currentID = servers.first?.id }
        persist()
    }

    /// Probes `/version` then an authenticated call, for the status dots and latency chips.
    func refreshReachability(_ server: ServerRecord) async {
        if reachability[server.id] == nil { reachability[server.id] = .checking }
        do {
            let (version, ms) = try await APIClient.probe(server.baseURL)
            if let c = client(for: server) {
                do {
                    _ = try await c.call("projects/list")
                    reachability[server.id] = .online(latencyMs: ms, version: version.short)
                    if let i = servers.firstIndex(where: { $0.id == server.id }), servers[i].lastVersion != version.short {
                        servers[i].lastVersion = version.short
                        persist()
                    }
                } catch APIError.unauthorized {
                    reachability[server.id] = .unauthorized
                }
            }
        } catch {
            if case .offline = reachability[server.id] { return }
            reachability[server.id] = .offline(since: Date())
        }
    }

    func refreshAll() async {
        await withTaskGroup(of: Void.self) { g in
            for s in servers { g.addTask { await self.refreshReachability(s) } }
        }
    }

    private func persist() {
        if let d = try? JSONEncoder().encode(servers) { try? d.write(to: fileURL, options: .atomic) }
    }
}
