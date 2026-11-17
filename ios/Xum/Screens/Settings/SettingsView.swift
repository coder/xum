import SwiftUI

/// Settings tab (docs/03 §15): server card, This iPhone (device settings) and On <server>
/// (server settings, fetched live). Detail rows push simple lists.
struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @AppStorage("xum.appearance") private var appearance = Appearance.system.rawValue
    @AppStorage("xum.requireFaceID") private var requireFaceID = false
    @State private var stats = ServerStats()

    var body: some View {
        List {
            serverSection
            deviceSection
            serverSettingsSection
            Section {
            } footer: {
                Text("Xum for iOS · v\(Self.appVersion)")
                    .frame(maxWidth: .infinity, alignment: .center)
            }
        }
        .listStyle(.insetGrouped)
        .listSectionSpacing(20)
        .scrollContentBackground(.hidden)
        .background(Color.xBg2.ignoresSafeArea())
        .navigationTitle("Settings")
        .task(id: model.servers.currentID) { await loadStats() }
    }

    static var appVersion: String {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "1.0"
    }

    /// Groups rows into one rounded `xCell` card like the mockup groups (radius 26).
    func cellRow<V: View>(first: Bool = false, last: Bool = false, @ViewBuilder content: () -> V) -> some View {
        content()
            .listRowInsets(EdgeInsets())
            .listRowSeparator(.hidden)
            .listRowBackground(Color.xCell)
            .overlay(alignment: .bottom) {
                if !last { Rectangle().fill(Color.xSep).frame(height: 0.5).padding(.leading, 58) }
            }
    }

    private var paddedRow: EdgeInsets { EdgeInsets(top: 0, leading: 16, bottom: 0, trailing: 16) }

    // MARK: Server

    private var serverSection: some View {
        Section {
            cellRow(first: true) {
                Button {
                    model.sheet = .servers
                } label: {
                    HStack(spacing: 12) {
                        SettingsTileIcon(color: .xAccentFill, systemImage: "server.rack", size: 40, radius: 12)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(serverName).font(.system(size: 17, weight: .semibold)).foregroundStyle(Color.xText)
                            reachabilityLine
                        }
                        Spacer(minLength: 8)
                        Image(systemName: "chevron.right").font(.system(size: 13, weight: .semibold)).foregroundStyle(Color.xText3)
                    }
                    .padding(paddedRow)
                    .frame(minHeight: 66)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
            cellRow(last: true) {
                Button {
                    model.sheet = .servers
                } label: {
                    HStack(spacing: 12) {
                        SettingsTileIcon(color: SettingsTile.slate, systemImage: "server.rack")
                        Text("All Servers").font(.system(size: 16)).foregroundStyle(Color.xText)
                        Spacer(minLength: 8)
                        Text("\(model.servers.servers.count)").font(.system(size: 16)).foregroundStyle(Color.xText2)
                        Image(systemName: "chevron.right").font(.system(size: 13, weight: .semibold)).foregroundStyle(Color.xText3)
                    }
                    .padding(paddedRow)
                    .frame(minHeight: 52)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
    }

    private var serverName: String {
        model.servers.current?.name ?? "Server"
    }

    @ViewBuilder
    private var reachabilityLine: some View {
        let state = model.servers.currentID.flatMap { model.servers.reachability[$0] } ?? .unknown
        HStack(spacing: 6) {
            switch state {
            case .online(let ms, let version):
                StatusDot(color: .xOk)
                Text("Connected · \(version) · \(ms) ms")
            case .checking:
                StatusDot(color: .xText3)
                Text("Checking…")
            case .unauthorized:
                StatusDot(color: .xBad)
                Text("Token rejected")
            case .offline:
                StatusDot(color: .xBad)
                Text("Offline")
            case .unknown:
                StatusDot(color: .xText3)
                Text("Not checked")
            }
        }
        .font(.system(size: 13))
        .foregroundStyle(Color.xText2)
    }

    // MARK: This iPhone

    private var deviceSection: some View {
        Section {
            cellRow(first: true) {
                Menu {
                    ForEach(Appearance.allCases, id: \.self) { a in
                        Button {
                            appearance = a.rawValue
                        } label: {
                            if a.rawValue == appearance { Label(a.label, systemImage: "checkmark") } else { Text(a.label) }
                        }
                    }
                } label: {
                    HStack(spacing: 12) {
                        SettingsTileIcon(color: SettingsTile.slate, systemImage: "circle.lefthalf.filled")
                        Text("Appearance").font(.system(size: 16)).foregroundStyle(Color.xText)
                        Spacer(minLength: 8)
                        Text(Appearance(rawValue: appearance)?.label ?? Appearance.system.label)
                            .font(.system(size: 16)).foregroundStyle(Color.xText2)
                        Image(systemName: "chevron.right").font(.system(size: 13, weight: .semibold)).foregroundStyle(Color.xText3)
                    }
                    .padding(paddedRow)
                    .frame(minHeight: 52)
                    .contentShape(Rectangle())
                }
            }
            cellRow {
                HStack(spacing: 12) {
                    SettingsTileIcon(color: SettingsTile.rust, systemImage: "bell")
                    Text("Notifications").font(.system(size: 16)).foregroundStyle(Color.xText)
                    Spacer(minLength: 8)
                    Text("Done, needs you").font(.system(size: 16)).foregroundStyle(Color.xText2)
                }
                .padding(paddedRow)
                .frame(minHeight: 52)
            }
            cellRow(last: true) {
                HStack(spacing: 12) {
                    SettingsTileIcon(color: SettingsTile.green, systemImage: "faceid")
                    Text("Require Face ID").font(.system(size: 16)).foregroundStyle(Color.xText)
                    Spacer(minLength: 8)
                    Toggle("Require Face ID", isOn: $requireFaceID)
                        .labelsHidden()
                        .tint(Color.xAccentFill)
                }
                .padding(paddedRow)
                .frame(minHeight: 52)
            }
        } header: {
            SectionCaption(text: "This iPhone").textCase(nil)
        }
    }

    // MARK: On <server>

    private var serverSettingsSection: some View {
        Section {
            cellRow(first: true) {
                NavigationLink { AgentListDetail() } label: {
                    detailRow(tile: SettingsTile.purple, icon: "cpu", title: "Agents", value: stats.agentCount.map(String.init))
                }
            }
            cellRow {
                NavigationLink { ProviderListDetail() } label: {
                    detailRow(tile: SettingsTile.blue, icon: "key", title: "Providers",
                              value: stats.configuredProviders.map(String.init))
                }
            }
            cellRow {
                NavigationLink { ModelListDetail() } label: {
                    detailRow(tile: SettingsTile.teal, icon: "square.stack.3d.up", title: "Models",
                              value: ModelName.display(model.defaultModel))
                }
            }
            cellRow {
                NavigationLink { MCPListDetail() } label: {
                    detailRow(tile: SettingsTile.violet, icon: "powerplug", title: "MCP Servers",
                              value: stats.mcpCount.map(String.init))
                }
            }
            cellRow {
                NavigationLink { SecretsDetail() } label: {
                    detailRow(tile: SettingsTile.rust, icon: "lock.fill", title: "Secrets", value: nil)
                }
            }
            cellRow(last: true) {
                NavigationLink { ServerAccessDetail() } label: {
                    detailRow(tile: SettingsTile.green, icon: "checkmark.shield", title: "Server Access",
                              value: stats.sessionCount.map { "\($0) sessions" })
                }
            }
        } header: {
            SectionCaption(text: "On \(serverName)").textCase(nil)
        }
    }

    private func detailRow(tile: Color, icon: String, title: String, value: String?) -> some View {
        HStack(spacing: 12) {
            SettingsTileIcon(color: tile, systemImage: icon)
            Text(title).font(.system(size: 16)).foregroundStyle(Color.xText)
            Spacer(minLength: 8)
            if let value {
                Text(value).font(.system(size: 16)).foregroundStyle(Color.xText2)
            }
        }
        .padding(paddedRow)
        .frame(minHeight: 52)
        .contentShape(Rectangle())
    }

    // MARK: Server counts

    private func loadStats() async {
        guard let client = model.servers.currentClient else { return }
        stats = ServerStats()
        async let agents = Self.loadAgents(client)
        async let providers = Self.loadConfiguredProviders(client)
        async let mcp = Self.loadMCPServers(client)
        async let sessions = Self.loadSessions(client)
        let (a, p, m, s) = await (agents, providers, mcp, sessions)
        stats = ServerStats(agentCount: a, configuredProviders: p?.configured, mcpCount: m, sessionCount: s)
    }

    static func loadAgents(_ client: APIClient) async -> Int? {
        guard let res = try? await client.call("agents/list") else { return nil }
        return res.array?.count
    }

    /// `providers/getConfig` shape is lenient: an object keyed by provider or a plain array.
    static func loadConfiguredProviders(_ client: APIClient) async -> (configured: Int, total: Int)? {
        guard let res = try? await client.call("providers/getConfig") else { return nil }
        if let obj = res.object {
            let configured = obj.values.filter { $0["isConfigured"]?.bool == true }.count
            return (configured, obj.count)
        }
        if let a = res.array {
            return (a.filter { $0["isConfigured"]?.bool == true }.count, a.count)
        }
        return nil
    }

    static func loadMCPServers(_ client: APIClient) async -> Int? {
        guard let res = try? await client.call("mcp/list", .object([:])) else { return nil }
        if let a = res.array { return a.count }
        return res.object?.count
    }

    static func loadSessions(_ client: APIClient) async -> Int? {
        guard let res = try? await client.call("serverAuth/listSessions") else { return nil }
        if let a = res.array { return a.count }
        return res["sessions"]?.array?.count
    }
}

private struct ServerStats {
    var agentCount: Int?
    var configuredProviders: Int?
    var mcpCount: Int?
    var sessionCount: Int?
}

/// Fixed tile colours from the mockups (docs/02 §2 "Fixed colours"); no matching tokens exist.
enum SettingsTile {
    static let slate = Color(uiColor: UIColor(hex: 0x2F2D33))
    static let rust = Color(uiColor: UIColor(hex: 0xA13000))
    static let green = Color(uiColor: UIColor(hex: 0x15803D))
    static let purple = Color(uiColor: UIColor(hex: 0x7511E2))
    static let blue = Color(uiColor: UIColor(hex: 0x2563EB))
    static let teal = Color(uiColor: UIColor(hex: 0x0E7C86))
    static let violet = Color(uiColor: UIColor(hex: 0x4A408F))
}

/// Rounded coloured tile with a white SF Symbol, like iOS Settings rows (docs/02 §5).
struct SettingsTileIcon: View {
    let color: Color
    let systemImage: String
    var size: CGFloat = 29
    var radius: CGFloat = 7

    var body: some View {
        Image(systemName: systemImage)
            .font(.system(size: size * 0.48, weight: .semibold))
            .foregroundStyle(.white)
            .frame(width: size, height: size)
            .background(RoundedRectangle(cornerRadius: radius, style: .continuous).fill(color))
    }
}