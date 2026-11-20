import SwiftUI

/// Simple detail lists behind the On <server> settings rows. Each calls the server once and
/// renders a lenient list; failures show an empty state instead of an error.

struct AgentListDetail: View {
    @Environment(AppModel.self) private var model
    @State private var agents: [(id: String, name: String)] = []
    @State private var failed = false

    var body: some View {
        List {
            if failed {
                Text("Could not load agents.").font(.system(size: 14)).foregroundStyle(Color.xText2)
            }
            ForEach(agents, id: \.id) { agent in
                VStack(alignment: .leading, spacing: 2) {
                    Text(agent.name).font(.system(size: 16)).foregroundStyle(Color.xText)
                    Text(agent.id).font(.xMono(12)).foregroundStyle(Color.xText3)
                }
                .padding(.vertical, 4)
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(Color.xBg.ignoresSafeArea())
        .navigationTitle("Agents")
        .navigationBarTitleDisplayMode(.inline)
        // Keyed by server: switching servers while this page is open loads the new one's list.
        .task(id: model.servers.currentID) {
            agents = []
            failed = false
            guard let client = model.servers.currentClient else { return }
            do {
                let res = try await client.call("agents/list", try SettingsView.agentDiscovery(model))
                agents = (res.array ?? []).compactMap { item in
                    guard let id = item["id"]?.string else { return nil }
                    return (id, item["name"]?.string ?? item["title"]?.string ?? id)
                }
            } catch { failed = true }
        }
    }
}

struct ProviderListDetail: View {
    @Environment(AppModel.self) private var model
    @State private var providers: [(name: String, configured: Bool)] = []
    @State private var failed = false

    var body: some View {
        List {
            if failed {
                Text("Could not load providers.").font(.system(size: 14)).foregroundStyle(Color.xText2)
            }
            ForEach(providers, id: \.name) { provider in
                HStack(spacing: 12) {
                    Text(provider.name).font(.system(size: 16)).foregroundStyle(Color.xText)
                    Spacer(minLength: 8)
                    if provider.configured {
                        Image(systemName: "checkmark.circle.fill").foregroundStyle(Color.xOk)
                            .accessibilityLabel("Configured")
                    } else {
                        Text("Not configured").font(.system(size: 13)).foregroundStyle(Color.xText3)
                    }
                }
                .padding(.vertical, 4)
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(Color.xBg.ignoresSafeArea())
        .navigationTitle("Providers")
        .navigationBarTitleDisplayMode(.inline)
        // Keyed by server: switching servers while this page is open loads the new one's list.
        .task(id: model.servers.currentID) {
            providers = []
            failed = false
            guard let client = model.servers.currentClient else { return }
            do {
                let res = try await client.call("providers/getConfig")
                if let obj = res.object {
                    providers = obj.map { ($0.key, $0.value["isConfigured"]?.bool == true) }.sorted { $0.name < $1.name }
                } else if let a = res.array {
                    providers = a.compactMap { item in
                        guard let name = item["name"]?.string ?? item["id"]?.string else { return nil }
                        return (name, item["isConfigured"]?.bool == true)
                    }
                }
            } catch { failed = true }
        }
    }
}

struct ModelListDetail: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        List {
            row("Default", value: ModelName.display(model.defaultModel))
            row("Provider", value: ModelName.provider(model.defaultModel))
            row("Thinking", value: model.defaultThinking.label)
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(Color.xBg.ignoresSafeArea())
        .navigationTitle("Models")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func row(_ title: String, value: String) -> some View {
        HStack(spacing: 12) {
            Text(title).font(.system(size: 16)).foregroundStyle(Color.xText)
            Spacer(minLength: 8)
            Text(value).font(.xMono(14)).foregroundStyle(Color.xText2)
        }
        .padding(.vertical, 4)
    }
}

struct MCPListDetail: View {
    @Environment(AppModel.self) private var model
    @State private var servers: [String] = []
    @State private var failed = false

    var body: some View {
        List {
            if failed {
                Text("Could not load MCP servers.").font(.system(size: 14)).foregroundStyle(Color.xText2)
            }
            ForEach(servers, id: \.self) { name in
                Text(name).font(.system(size: 16)).foregroundStyle(Color.xText).padding(.vertical, 4)
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(Color.xBg.ignoresSafeArea())
        .navigationTitle("MCP Servers")
        .navigationBarTitleDisplayMode(.inline)
        // Keyed by server: switching servers while this page is open loads the new one's list.
        .task(id: model.servers.currentID) {
            servers = []
            failed = false
            guard let client = model.servers.currentClient else { return }
            do {
                let res = try await client.call("mcp/list", .object([:]))
                if let obj = res.object {
                    servers = obj.keys.sorted()
                } else if let a = res.array {
                    servers = a.compactMap { $0["name"]?.string ?? $0["id"]?.string }
                }
            } catch { failed = true }
        }
    }
}

struct SecretsDetail: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        ContentUnavailableView {
            Label("Secrets", systemImage: "lock.fill")
        } description: {
            Text("Secrets live on \(model.servers.current?.name ?? "the server"). Manage them from the desktop settings.")
        }
        .navigationTitle("Secrets")
        .navigationBarTitleDisplayMode(.inline)
    }
}

struct ServerAccessDetail: View {
    @Environment(AppModel.self) private var model
    @State private var sessions: [ServerSession] = []
    @State private var listen: String?
    @State private var lan: Bool?
    @State private var failed = false
    @State private var revokeError: String?

    struct ServerSession: Identifiable {
        let id: String
        let label: String
        let lastUsed: Date
        let isCurrent: Bool
    }

    private var serverName: String { model.servers.current?.name ?? "the server" }

    var body: some View {
        List {
            Section {
            } footer: {
                Text("Phones and browsers you pair can steer agents on \(serverName). Revoke one to sign it out.")
                    .font(.system(size: 15))
                    .foregroundStyle(Color.xText2)
                    .textCase(nil)
            }
            Section {
                thisDeviceRow
                ForEach(sessions.filter { !$0.isCurrent }) { session in
                    sessionRow(session)
                }
                if failed {
                    Text("Could not load sessions.").font(.system(size: 14)).foregroundStyle(Color.xText2)
                        .listRowBackground(Color.xCell)
                }
                if let revokeError {
                    Text(revokeError).font(.system(size: 14)).foregroundStyle(Color.xBad)
                        .listRowBackground(Color.xCell)
                }
            } header: {
                SectionCaption(text: "Sessions · \(sessions.filter { !$0.isCurrent }.count + 1)").textCase(nil)
            }
            Section {
                LabeledContent("Listen on") {
                    Text(listen ?? "…").font(.xMono(14)).foregroundStyle(Color.xText2)
                }
                .listRowBackground(Color.xCell)
                LabeledContent("Allow LAN connections") {
                    Text(lan.map { $0 ? "On" : "Off" } ?? "…").foregroundStyle(Color.xText2)
                }
                .listRowBackground(Color.xCell)
            } header: {
                SectionCaption(text: "Network").textCase(nil)
            } footer: {
                Text("Change the bind address in Xum on the computer.").font(.system(size: 13)).foregroundStyle(Color.xText3)
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(Color.xBg2.ignoresSafeArea())
        .navigationTitle("Server Access")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                // Per-device pairing codes are not on the server yet (design docs/07): the button
                // stays visible but disabled until that endpoint exists.
                Button {} label: { Label("Pair Device", systemImage: "qrcode") }
                    .disabled(true)
            }
        }
        .task(id: model.servers.currentID) { await load() }
    }

    private var thisDeviceRow: some View {
        HStack(spacing: 12) {
            SettingsTileIcon(color: SettingsTile.slate, systemImage: "iphone")
            VStack(alignment: .leading, spacing: 2) {
                Text(UIDevice.current.name).font(.system(size: 16)).foregroundStyle(Color.xText)
                Text("This device · access token").font(.system(size: 13)).foregroundStyle(Color.xText2)
            }
            Spacer(minLength: 8)
            StatusDot(color: .xOk)
            Text("Now").font(.system(size: 14)).foregroundStyle(Color.xText2)
        }
        .padding(.vertical, 4)
        .listRowBackground(Color.xCell)
    }

    private func sessionRow(_ session: ServerSession) -> some View {
        HStack(spacing: 12) {
            SettingsTileIcon(color: SettingsTile.blue, systemImage: "globe")
            VStack(alignment: .leading, spacing: 2) {
                Text(session.label).font(.system(size: 16)).foregroundStyle(Color.xText).lineLimit(1)
                Text("last used \(RelativeTime.short(session.lastUsed))").font(.xMono(12)).foregroundStyle(Color.xText2)
            }
            Spacer(minLength: 8)
            Button("Revoke") { Task { await revoke(session) } }
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(Color.xBad)
                .buttonStyle(.glass)
        }
        .padding(.vertical, 4)
        .listRowBackground(Color.xCell)
    }

    private func load() async {
        sessions = []
        listen = nil
        lan = nil
        failed = false
        guard let client = model.servers.currentClient else { return }
        if let res = try? await client.call("serverAuth/listSessions") {
            sessions = (res.array ?? []).compactMap { item in
                guard let id = item["id"]?.string else { return nil }
                let ms = item["lastUsedAtMs"]?.double ?? 0
                return ServerSession(
                    id: id,
                    label: item["label"]?.string ?? "Browser",
                    lastUsed: Date(timeIntervalSince1970: ms / 1000),
                    isCurrent: item["isCurrent"]?.bool ?? false
                )
            }
        } else {
            failed = true
        }
        if let status = try? await client.call("server/getApiServerStatus") {
            let host = status["bindHost"]?.string
            let port = status["port"]?.double.map { String(Int($0)) } ?? ""
            let lanURL = status["networkBaseUrls"]?.array?.first?.string.flatMap(URL.init(string:))
            listen = lanURL.map { "\($0.host() ?? ""):\(port)" } ?? host.map { "\($0):\(port)" }
            lan = host.map { $0 != "127.0.0.1" && $0 != "localhost" && $0 != "::1" }
        }
    }

    private func revoke(_ session: ServerSession) async {
        guard let client = model.servers.currentClient else { return }
        // The row goes only once the server confirms: a revoke that failed must not look done.
        do {
            let r = try await client.call("serverAuth/revokeSession", ["sessionId": .string(session.id)])
            revokeError = nil
            if r["removed"]?.bool == true {
                sessions.removeAll { $0.id == session.id }
            } else {
                await load()
            }
        } catch {
            revokeError = "Could not revoke \(session.label): \(error.localizedDescription)"
        }
    }
}
