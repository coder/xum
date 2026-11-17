import Foundation

/// A Xum connection link: `<baseUrl>/?token=<urlencoded token>` (the "Open in browser" link that
/// `xum server` prints). Also accepts `xum://connect?url=<baseUrl>&token=<token>`.
struct ConnectionLink: Equatable, Sendable {
    var baseURL: URL
    var token: String

    var host: String { baseURL.host() ?? "" }
    var port: Int? { baseURL.port ?? (baseURL.scheme == "https" ? 443 : 80) }
    /// Default server name: the host's first label (`devbox` for `devbox.tail4e2c.ts.net`).
    var suggestedName: String {
        let h = host
        if h.split(separator: ".").count == 4, h.allSatisfy({ $0.isNumber || $0 == "." }) { return h }
        return h.split(separator: ".").first.map(String.init) ?? h
    }
    var tokenLast4: String { String(token.suffix(4)) }

    static func parse(_ raw: String) -> ConnectionLink? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let comps = URLComponents(string: trimmed), let scheme = comps.scheme?.lowercased() else { return nil }
        let items = comps.queryItems ?? []
        if scheme == "xum" {
            guard let u = items.first(where: { $0.name == "url" })?.value,
                  let t = items.first(where: { $0.name == "token" })?.value,
                  let inner = parse("\(u)?token=\(t.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? t)") else { return nil }
            return inner
        }
        guard scheme == "http" || scheme == "https", let host = comps.host, !host.isEmpty,
              let token = items.first(where: { $0.name == "token" })?.value, !token.isEmpty else { return nil }
        var base = URLComponents()
        base.scheme = scheme
        base.host = host
        base.port = comps.port
        // Keep a path prefix (a server behind a reverse proxy) but drop the web UI route.
        let path = comps.path.hasSuffix("/") ? String(comps.path.dropLast()) : comps.path
        base.path = path.isEmpty ? "/" : path + "/"
        guard let url = base.url else { return nil }
        return ConnectionLink(baseURL: url, token: token)
    }
}
