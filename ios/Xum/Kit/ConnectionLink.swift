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

    /// The link in its `<baseUrl>?token=` form.
    var urlString: String {
        baseURL.absoluteString + "?token=" + (token.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? token)
    }

    /// Whether the token is protected in transit: HTTPS, a loopback host (it never leaves the
    /// device), or a Tailscale address (WireGuard encrypts the tailnet). Anything else is plain
    /// HTTP that anyone on the network path can read, and the token lets its holder run commands
    /// on the server.
    var isProtectedTransport: Bool { protectedTransport(tailnetUp: Tailnet.isUp) }

    /// `tailnetUp`: this device has a Tailscale address on a VPN tunnel. A 100.64.0.0/10 address
    /// alone can be ordinary RFC 6598 carrier NAT, so it counts only then.
    func protectedTransport(tailnetUp: Bool) -> Bool {
        if baseURL.scheme?.lowercased() == "https" { return true }
        let h = host.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
        if h == "localhost" { return true }
        if h.hasSuffix(".ts.net") { return tailnetUp }
        // Only literal addresses count: a hostname such as `127.attacker.example` resolves anywhere.
        guard let ip = IPAddress(h) else { return false }
        return ip.isLoopback || (ip.isTailscale && tailnetUp)
    }

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

/// A literal IPv4 or IPv6 address.
struct IPAddress {
    let bytes: [UInt8]

    init?(_ text: String) {
        var v4 = in_addr()
        var v6 = in6_addr()
        if inet_pton(AF_INET, text, &v4) == 1 {
            bytes = withUnsafeBytes(of: &v4) { Array($0) }
        } else if inet_pton(AF_INET6, text, &v6) == 1 {
            bytes = withUnsafeBytes(of: &v6) { Array($0) }
        } else {
            return nil
        }
    }

    init(bytes: [UInt8]) { self.bytes = bytes }

    /// 127.0.0.0/8 or ::1.
    var isLoopback: Bool {
        bytes.count == 4 ? bytes[0] == 127 : bytes[0..<15].allSatisfy { $0 == 0 } && bytes[15] == 1
    }

    /// Tailscale's ranges: 100.64.0.0/10 and fd7a:115c:a1e0::/48.
    var isTailscale: Bool {
        bytes.count == 4 ? bytes[0] == 100 && bytes[1] & 0xC0 == 64 : Array(bytes[0..<6]) == [0xfd, 0x7a, 0x11, 0x5c, 0xa1, 0xe0]
    }
}

/// Whether Tailscale is connected on this device: a `utun` tunnel holds a Tailscale address.
/// Carrier NAT puts 100.64.0.0/10 on the cellular or Wi-Fi interface, never on a tunnel.
enum Tailnet {
    static var isUp: Bool {
        var head: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&head) == 0 else { return false }
        defer { freeifaddrs(head) }
        var p = head
        while let ifa = p {
            defer { p = ifa.pointee.ifa_next }
            guard String(cString: ifa.pointee.ifa_name).hasPrefix("utun"), let sa = ifa.pointee.ifa_addr else { continue }
            if sa.pointee.sa_family == UInt8(AF_INET) {
                let a = sa.withMemoryRebound(to: sockaddr_in.self, capacity: 1) { $0.pointee.sin_addr }
                if IPAddress(bytes: withUnsafeBytes(of: a) { Array($0) }).isTailscale { return true }
            } else if sa.pointee.sa_family == UInt8(AF_INET6) {
                let a = sa.withMemoryRebound(to: sockaddr_in6.self, capacity: 1) { $0.pointee.sin6_addr }
                if IPAddress(bytes: withUnsafeBytes(of: a) { Array($0) }).isTailscale { return true }
            }
        }
        return false
    }
}
