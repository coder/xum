import SwiftUI

extension ServerStore {
    /// Dot colour for the status pill and menu rows: online ok, offline bad, unauthorized warn.
    func dotColor(for server: ServerRecord) -> Color {
        switch reachability[server.id] {
        case .online: .xOk
        case .offline: .xBad
        case .unauthorized: .xWarn
        case .checking, .unknown, nil: .xText3
        }
    }

    /// Row status text: the current server shows live agent count, others Idle / Offline.
    func statusLabel(for server: ServerRecord, runningCount: Int) -> String {
        switch reachability[server.id] {
        case .online:
            server.id == currentID ? "\(runningCount) running" : "Idle"
        case .offline: "Offline"
        case .unauthorized: "Unauthorized"
        case .checking: "Checking"
        case .unknown, nil: "Idle"
        }
    }
}

/// Switch A: the leading toolbar item on server-backed screens. A glass server pill that opens
/// the switch menu.
struct ServerMenuButton: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        Menu {
            Section("Servers") {
                ForEach(model.servers.servers) { server in
                    Button {
                        model.switchServer(server.id)
                    } label: {
                        HStack(spacing: 12) {
                            Group {
                                if server.id == model.servers.currentID {
                                    Image(systemName: "checkmark")
                                } else {
                                    Image(systemName: "checkmark").hidden()
                                }
                            }
                            .font(.system(size: 13, weight: .semibold))
                            .frame(width: 16)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(server.name)
                                Text(server.hostLabel)
                                    .font(.xMono(12))
                                    .foregroundStyle(Color.xText2)
                            }
                            Spacer(minLength: 12)
                            HStack(spacing: 6) {
                                StatusDot(color: model.servers.dotColor(for: server))
                                Text(model.servers.statusLabel(for: server, runningCount: model.list?.runningCount ?? 0))
                            }
                            .font(.system(size: 13))
                            .foregroundStyle(Color.xText2)
                        }
                    }
                }
            }
            Divider()
            Button { model.sheet = .scanner } label: {
                Label("Scan QR Code", systemImage: "qrcode.viewfinder")
            }
            Button { model.sheet = .connectLink(prefill: nil) } label: {
                Label("Enter Connection Link", systemImage: "link")
            }
            Button { model.sheet = .servers } label: {
                Label("Manage Servers", systemImage: "server.rack")
            }
        } label: {
            HStack(spacing: 8) {
                StatusDot(color: currentDotColor)
                Text(currentName)
                    .font(.system(size: 15, weight: .semibold))
                    .lineLimit(1)
                Image(systemName: "chevron.down")
                    .font(.system(size: 11, weight: .semibold))
            }
            .foregroundStyle(Color.xText)
            .padding(.leading, 16)
            .padding(.trailing, 12)
            .frame(height: 44)
            .glassCapsule()
        }
    }

    private var currentServer: ServerRecord? {
        model.servers.current ?? model.servers.servers.first
    }

    private var currentName: String { currentServer?.name ?? "Servers" }

    private var currentDotColor: Color {
        guard let s = currentServer else { return Color.xText3 }
        return model.servers.dotColor(for: s)
    }
}
