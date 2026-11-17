import Foundation

enum APIError: Error, LocalizedError, Equatable {
    case unauthorized
    case http(Int, String)
    case transport(String)
    case decoding

    var errorDescription: String? {
        switch self {
        case .unauthorized: "Token rejected"
        case .http(let code, let body): "Server error \(code): \(body.prefix(120))"
        case .transport(let m): m
        case .decoding: "Unexpected response"
        }
    }
}

/// Talks to one Xum server over its OpenAPI REST surface: `POST /api/<ns>/<proc>` with JSON, and
/// event-iterator procedures as Server-Sent Events. The app sends no `Origin` header, which the
/// server's origin check allows for native clients.
struct APIClient: Sendable {
    let baseURL: URL
    let token: String

    private static let session: URLSession = {
        let c = URLSessionConfiguration.default
        c.timeoutIntervalForRequest = 20
        c.waitsForConnectivity = false
        return URLSession(configuration: c)
    }()

    private static let streamSession: URLSession = {
        let c = URLSessionConfiguration.default
        c.timeoutIntervalForRequest = 24 * 3600
        c.timeoutIntervalForResource = 7 * 24 * 3600
        return URLSession(configuration: c)
    }()

    func url(_ procedure: String) -> URL {
        baseURL.appending(path: "api/" + procedure)
    }

    private func request(_ procedure: String, body: JSONValue?) -> URLRequest {
        var r = URLRequest(url: url(procedure))
        r.httpMethod = "POST"
        r.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if let body {
            r.setValue("application/json", forHTTPHeaderField: "Content-Type")
            r.httpBody = try? JSONEncoder().encode(body)
        }
        return r
    }

    /// Unary call. Pass `nil` for void-input procedures (they reject `{}`).
    @discardableResult
    func call(_ procedure: String, _ body: JSONValue? = nil) async throws -> JSONValue {
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await Self.session.data(for: request(procedure, body: body))
        } catch {
            throw APIError.transport(error.localizedDescription)
        }
        let code = (response as? HTTPURLResponse)?.statusCode ?? 0
        if code == 401 { throw APIError.unauthorized }
        guard (200..<300).contains(code) else { throw APIError.http(code, String(decoding: data, as: UTF8.self)) }
        if data.isEmpty { return .null }
        guard let v = JSONValue.parse(data) else { throw APIError.decoding }
        return v
    }

    /// Subscription: yields each SSE `data:` payload as JSON. Ends when the server closes the
    /// stream or the consuming task is cancelled.
    func subscribe(_ procedure: String, _ body: JSONValue? = nil) -> AsyncThrowingStream<JSONValue, Error> {
        let req = { () -> URLRequest in
            var r = request(procedure, body: body)
            r.setValue("text/event-stream", forHTTPHeaderField: "Accept")
            return r
        }()
        return AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    let (bytes, response) = try await Self.streamSession.bytes(for: req)
                    let code = (response as? HTTPURLResponse)?.statusCode ?? 0
                    if code == 401 { throw APIError.unauthorized }
                    guard (200..<300).contains(code) else { throw APIError.http(code, "") }
                    var dataLines: [String] = []
                    for try await line in bytes.lines {
                        if line.hasPrefix("data:") {
                            dataLines.append(String(line.dropFirst(5)).trimmingCharacters(in: .whitespaces))
                            // URLSession's `lines` drops the blank separator line, so dispatch each
                            // complete JSON payload as soon as it parses.
                            let joined = dataLines.joined(separator: "\n")
                            if let v = JSONValue.parse(Data(joined.utf8)) {
                                continuation.yield(v)
                                dataLines.removeAll()
                            }
                        } else if line.isEmpty, !dataLines.isEmpty {
                            dataLines.removeAll()
                        }
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    /// `GET /version` with round-trip time, for "Reachable · 38 ms".
    static func probe(_ baseURL: URL) async throws -> (version: ServerVersion, latencyMs: Int) {
        var r = URLRequest(url: baseURL.appending(path: "version"))
        r.timeoutInterval = 6
        let start = Date()
        let (data, response): (Data, URLResponse)
        do { (data, response) = try await session.data(for: r) } catch { throw APIError.transport(error.localizedDescription) }
        let ms = Int(Date().timeIntervalSince(start) * 1000)
        guard (response as? HTTPURLResponse)?.statusCode == 200, let v = JSONValue.parse(data) else { throw APIError.decoding }
        return (ServerVersion(json: v), max(ms, 1))
    }
}

struct ServerVersion: Codable, Hashable, Sendable {
    var gitDescribe: String
    var gitCommit: String
    init(json: JSONValue) {
        gitDescribe = json["git_describe"]?.string ?? "unknown"
        gitCommit = json["git_commit"]?.string ?? ""
    }
    /// Short label for UI: `v0.32.3` from `v0.32.3-nightly.42-2-g70ab64f4d`.
    var short: String {
        let parts = gitDescribe.split(separator: "-")
        return parts.first.map(String.init) ?? gitDescribe
    }
}
