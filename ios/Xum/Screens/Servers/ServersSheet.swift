import SwiftUI

/// Switch B: manage saved servers. Current server card, others with Edit / Forget swipe actions,
/// and the two add paths.
struct ServersSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var renaming: ServerRecord?
    @State private var renameText = ""

    private var others: [ServerRecord] {
        model.servers.servers.filter { $0.id != model.servers.currentID }
    }

    var body: some View {
        NavigationStack {
            List {
                if let current = model.servers.current {
                    Section {
                        CurrentServerCard(server: current)
                            .listRowInsets(EdgeInsets())
                            .listRowBackground(Color.clear)
                            .listRowSeparator(.hidden)
                    }
                }
                if !others.isEmpty {
                    Section {
                        ForEach(others) { server in
                            otherRow(server)
                                .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                                    Button(role: .destructive) {
                                        model.forgetServer(server.id)
                                    } label: {
                                        Label("Forget", systemImage: "trash")
                                    }
                                    Button {
                                        renaming = server
                                        renameText = server.name
                                    } label: {
                                        Label("Edit", systemImage: "pencil")
                                    }
                                }
                        }
                    } header: {
                        SectionCaption(text: "Other servers")
                    }
                }
                Section {
                    addRow("Scan QR Code", systemImage: "qrcode.viewfinder", tinted: true) {
                        model.sheet = .scanner
                    }
                    addRow("Enter Connection Link", systemImage: "link", tinted: false) {
                        model.sheet = .connectLink(prefill: nil)
                    }
                } header: {
                    SectionCaption(text: "Add a server")
                }
                Section {
                    Text("Each server keeps its own token in Keychain. Alerts from every server reach you, even when it isn't current.")
                        .font(.system(size: 13))
                        .foregroundStyle(Color.xText3)
                        .lineSpacing(2)
                        .listRowBackground(Color.clear)
                        .listRowSeparator(.hidden)
                }
            }
            .listStyle(.insetGrouped)
            .scrollContentBackground(.hidden)
            .background(Color.xBg2)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button { dismiss() } label: {
                        Image(systemName: "xmark")
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(Color.xText)
                    }
                }
                ToolbarItem(placement: .principal) {
                    Text("Servers").font(.system(size: 17, weight: .semibold))
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button { model.sheet = .scanner } label: {
                            Label("Scan QR Code", systemImage: "qrcode.viewfinder")
                        }
                        Button { model.sheet = .connectLink(prefill: nil) } label: {
                            Label("Enter Connection Link", systemImage: "link")
                        }
                    } label: {
                        Image(systemName: "plus")
                            .font(.system(size: 17, weight: .medium))
                            .foregroundStyle(Color.xText)
                    }
                }
            }
            .task { await model.servers.refreshAll() }
            .alert("Rename Server", isPresented: Binding(
                get: { renaming != nil },
                set: { if !$0 { renaming = nil } }
            )) {
                TextField("Name", text: $renameText)
                Button("Cancel", role: .cancel) { renaming = nil }
                Button("Save") {
                    if let r = renaming { model.servers.rename(r.id, to: renameText) }
                    renaming = nil
                }
            }
        }
    }

    private func otherRow(_ server: ServerRecord) -> some View {
        Button {
            model.switchServer(server.id)
        } label: {
            HStack(spacing: 12) {
                RoundedRectangle(cornerRadius: 8)
                    .fill(Color.xFill)
                    .frame(width: 30, height: 30)
                    .overlay(Image(systemName: "desktopcomputer").font(.system(size: 13)).foregroundStyle(Color.xText))
                VStack(alignment: .leading, spacing: 2) {
                    Text(server.name).font(.system(size: 16)).foregroundStyle(Color.xText)
                    Text(server.hostLabel).font(.xMono(12.5)).foregroundStyle(Color.xText2).lineLimit(1).truncationMode(.middle)
                }
                Spacer(minLength: 8)
                HStack(spacing: 6) {
                    StatusDot(color: statusColor(server))
                    Text(statusText(server)).font(.system(size: 13))
                }
                .foregroundStyle(statusColor(server) == .xOk ? Color.xText2 : statusColor(server))
                Image(systemName: "chevron.right").font(.system(size: 12)).foregroundStyle(Color.xText3)
            }
            .padding(.vertical, 8)
        }
        .buttonStyle(.plain)
    }

    private func statusColor(_ server: ServerRecord) -> Color {
        model.servers.dotColor(for: server)
    }

    private func statusText(_ server: ServerRecord) -> String {
        if case .offline(let since) = model.servers.reachability[server.id] {
            return "Offline · \(RelativeTime.short(since))"
        }
        return model.servers.statusLabel(for: server, runningCount: model.list?.runningCount ?? 0)
    }

    private func addRow(_ title: String, systemImage: String, tinted: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 12) {
                RoundedRectangle(cornerRadius: 8)
                    .fill(tinted ? Color.xAccentFill : Color.xText2)
                    .frame(width: 30, height: 30)
                    .overlay(Image(systemName: systemImage).font(.system(size: 13)).foregroundStyle(Color.white))
                Text(title).font(.system(size: 16)).foregroundStyle(Color.xText)
                Spacer()
                Image(systemName: "chevron.right").font(.system(size: 12)).foregroundStyle(Color.xText3)
            }
        }
        .buttonStyle(.plain)
    }
}

private struct CurrentServerCard: View {
    @Environment(AppModel.self) private var model
    let server: ServerRecord

    private var reachability: ServerReachability? { model.servers.reachability[server.id] }

    private var version: String? {
        if case .online(_, let v) = reachability { return v }
        return server.lastVersion
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 10) {
                StatusDot(color: model.servers.dotColor(for: server), size: 10)
                Text(server.name)
                    .font(.system(size: 20, weight: .semibold))
                    .foregroundStyle(Color.xText)
                    .lineLimit(1)
                Spacer(minLength: 8)
                Text("CURRENT")
                    .font(.xCaption)
                    .kerning(0.4)
                    .foregroundStyle(Color.xAccent)
            }
            Text(version.map { "\(server.hostLabel) · \($0)" } ?? server.hostLabel)
                .font(.xMono(13))
                .foregroundStyle(Color.xText2)
                .lineLimit(1)
                .truncationMode(.middle)
                .padding(.top, 4)
            HStack(spacing: 8) {
                Chip {
                    HStack(spacing: 5) {
                        Image(systemName: "arrow.triangle.2.circlepath").foregroundStyle(Color.xAccent)
                        Text("\(model.list?.runningCount ?? 0) running")
                    }
                }
                if let waiting = model.list?.waitingCount, waiting > 0 {
                    Chip { Text("\(waiting) waiting on you").foregroundStyle(Color.xWarn) }
                }
                if case .online(let ms, _) = reachability {
                    Chip { Text("\(ms) ms").foregroundStyle(Color.xText2) }
                }
            }
            .padding(.top, 14)
        }
        .padding(18)
        .background(Color.xCell, in: RoundedRectangle(cornerRadius: 20))
        .overlay(RoundedRectangle(cornerRadius: 20).strokeBorder(Color.xAccent, lineWidth: 1.5))
    }
}
