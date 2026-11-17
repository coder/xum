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
        .task {
            guard let client = model.servers.currentClient, agents.isEmpty else { return }
            do {
                let res = try await client.call("agents/list")
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
        .task {
            guard let client = model.servers.currentClient, providers.isEmpty else { return }
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
        .task {
            guard let client = model.servers.currentClient, servers.isEmpty else { return }
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
    @State private var sessions: [(id: String, label: String)] = []
    @State private var failed = false

    var body: some View {
        List {
            if failed {
                Text("Could not load sessions.").font(.system(size: 14)).foregroundStyle(Color.xText2)
            }
            ForEach(sessions, id: \.id) { session in
                Text(session.label).font(.system(size: 16)).foregroundStyle(Color.xText).padding(.vertical, 4)
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(Color.xBg.ignoresSafeArea())
        .navigationTitle("Server Access")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            guard let client = model.servers.currentClient, sessions.isEmpty else { return }
            do {
                let res = try await client.call("serverAuth/listSessions")
                let raw = res.array ?? res["sessions"]?.array ?? []
                sessions = raw.enumerated().compactMap { i, item in
                    let fallback = "Session \(i + 1)"
                    let label = item["userAgent"]?.string ?? item["client"]?.string
                        ?? item["label"]?.string ?? item["ip"]?.string ?? fallback
                    let id = item["id"]?.string ?? String(i)
                    return (id, label)
                }
            } catch { failed = true }
        }
    }
}