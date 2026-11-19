import SwiftUI
import UIKit

/// Connect C: paste or edit a connection link, watch it parse and probe, then save.
struct ConnectLinkSheet: View {
    var prefill: String?

    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""
    @State private var name = ""
    @State private var nameEdited = false
    @State private var revealToken = false
    @State private var status: ProbeStatus = .idle
    @State private var version: String?
    @State private var pastedFromMac = false

    enum ProbeStatus: Equatable {
        case idle, checking, reachable(ms: Int), unreachable, rejected

        var color: Color? {
            switch self {
            case .reachable: .xOk
            case .unreachable, .rejected: .xBad
            case .checking, .idle: .xText3
            }
        }

        var label: String {
            switch self {
            case .idle: ""
            case .checking: "Checking…"
            case .reachable(let ms): "Reachable · \(ms) ms"
            case .unreachable: "Unreachable"
            case .rejected: "Token rejected"
            }
        }
    }

    init(prefill: String?) {
        self.prefill = prefill
        _text = State(initialValue: prefill ?? "")
    }

    private var parsed: ConnectionLink? { ConnectionLink.parse(text) }
    @State private var allowCleartext = false
    /// Sending the token is allowed: the transport protects it, or the user accepted plain HTTP.
    private func mayUseToken(_ link: ConnectionLink) -> Bool { link.isProtectedTransport || allowCleartext }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    SectionCaption(text: "Link")
                    linkField.padding(.top, 8)
                    if pastedFromMac {
                        pastedRow.padding(.top, 8)
                    }
                    if let link = parsed {
                        SectionCaption(text: "Parsed").padding(.top, 22)
                        parsedGroup(link).padding(.top, 8)
                        if !link.isProtectedTransport { cleartextWarning.padding(.top, 12) }
                        nameGroup(link).padding(.top, 12)
                        Text("The token stays in this iPhone's Keychain. Revoke it any time from Server Access on the computer.")
                            .font(.system(size: 13))
                            .foregroundStyle(Color.xText3)
                            .lineSpacing(2)
                            .padding(.top, 10)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.top, 8)
                .padding(.bottom, 16)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
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
                    Text("Connection Link").font(.system(size: 17, weight: .semibold))
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button(action: confirm) {
                        Image(systemName: "checkmark")
                            .font(.system(size: 15, weight: .semibold))
                            .frame(width: 44, height: 44)
                    }
                    .buttonStyle(.glassProminent)
                    .disabled(parsed.map { !mayUseToken($0) } ?? true)
                }
            }
            .safeAreaInset(edge: .bottom) {
                Button { model.sheet = .scanner } label: {
                    Label("Scan a QR code instead", systemImage: "qrcode.viewfinder")
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(Color.xAccent)
                        .frame(maxWidth: .infinity)
                        .frame(height: 50)
                }
                .padding(.bottom, 8)
                .frame(maxWidth: .infinity)
                // Opaque, so the form does not show through when it scrolls under the button.
                .background(Color.xBg2)
            }
            .task(id: "\(text)|\(allowCleartext)") { await probe() }
            .task { checkClipboardOrigin() }
            .onChange(of: parsed) { _, link in
                if let link, !nameEdited { name = link.suggestedName }
            }
        }
    }

    private func confirm() {
        guard let link = parsed, mayUseToken(link) else { return }
        model.addServer(link, name: name.isEmpty ? link.suggestedName : name, version: version)
    }

    /// Debounced live probe of the link: 400 ms after the text settles, check reachability and token.
    private func probe() async {
        guard let link = ConnectionLink.parse(text) else {
            status = .idle
            version = nil
            return
        }
        status = .checking
        try? await Task.sleep(for: .milliseconds(400))
        if Task.isCancelled { return }
        do {
            let (v, ms) = try await APIClient.probe(link.baseURL)
            if Task.isCancelled { return }
            // Do not send the token over plain HTTP before the user accepts that.
            guard mayUseToken(link) else {
                status = .reachable(ms: ms)
                version = v.short
                return
            }
            do {
                _ = try await APIClient(baseURL: link.baseURL, token: link.token).call("projects/list")
                if Task.isCancelled { return }
                status = .reachable(ms: ms)
                version = v.short
            } catch let error as APIError {
                status = error == .unauthorized ? .rejected : .unreachable
            } catch {
                status = .unreachable
            }
        } catch {
            if Task.isCancelled { return }
            status = .unreachable
        }
    }

    private var cleartextWarning: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("This link is not encrypted", systemImage: "lock.open")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(Color.xWarn)
            Text("Anyone on this network can read the token and use it to run commands on the server. Use an HTTPS link or a Tailscale address when you can.")
                .font(.system(size: 13))
                .foregroundStyle(Color.xText2)
                .fixedSize(horizontal: false, vertical: true)
            Toggle("Connect over plain HTTP", isOn: $allowCleartext)
                .font(.system(size: 15))
                .tint(Color.xWarn)
        }
        .padding(14)
        .background(Color.xWarn.opacity(0.10), in: RoundedRectangle(cornerRadius: 14))
    }

    /// The "Pasted from your Mac" row shows only when the prefill still matches the clipboard.
    private func checkClipboardOrigin() {
        guard let prefill else { return }
        pastedFromMac = UIPasteboard.general.string == prefill
            || UIPasteboard.general.url?.absoluteString == prefill
    }

    private var linkField: some View {
        HStack(alignment: .top, spacing: 8) {
            TextField("https://host:3000/?token=…", text: $text, axis: .vertical)
                .font(.xMono(14))
                .lineLimit(2...5)
            if !text.isEmpty {
                Button { text = "" } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 10, weight: .bold))
                        .foregroundStyle(Color.xText2)
                        .frame(width: 24, height: 24)
                        .background(Color.xFill, in: Circle())
                }
            }
        }
        .padding(EdgeInsets(top: 14, leading: 16, bottom: 14, trailing: 12))
        .background(Color.xFill2, in: RoundedRectangle(cornerRadius: 22))
    }

    private var pastedRow: some View {
        HStack(spacing: 6) {
            Image(systemName: "doc.on.clipboard")
                .font(.system(size: 13))
                .foregroundStyle(Color.xAccent)
            Text("Pasted from your Mac")
                .font(.system(size: 13))
                .foregroundStyle(Color.xText2)
        }
        .padding(.leading, 16)
    }

    private func parsedGroup(_ link: ConnectionLink) -> some View {
        VStack(spacing: 0) {
            kvRow("Host") {
                Text(link.host)
                    .font(.xMono(14))
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            Divider()
            kvRow("Port") {
                Text(link.port.map(String.init) ?? "")
                    .font(.xMono(14))
            }
            Divider()
            kvRow("Token") {
                HStack(spacing: 4) {
                    Text(revealToken ? link.token : "•••••••• \(link.tokenLast4)")
                        .font(.xMono(14))
                        .lineLimit(1)
                        .truncationMode(.head)
                    Button { revealToken.toggle() } label: {
                        Image(systemName: revealToken ? "eye.slash" : "eye")
                            .font(.system(size: 13))
                            .foregroundStyle(Color.xText2)
                            .frame(width: 32, height: 32)
                    }
                }
            }
            Divider()
            kvRow("Status") {
                HStack(spacing: 7) {
                    StatusDot(color: status.color ?? .xText3)
                    Text(status.label).font(.system(size: 15)).foregroundStyle(Color.xText2)
                }
            }
        }
        .padding(.horizontal, 16)
        .background(Color.xFill2, in: RoundedRectangle(cornerRadius: 26))
    }

    private func nameGroup(_ link: ConnectionLink) -> some View {
        HStack {
            Text("Name").font(.system(size: 15)).foregroundStyle(Color.xText2)
            Spacer()
            TextField("Name", text: Binding(
                get: { name.isEmpty ? link.suggestedName : name },
                set: { name = $0; nameEdited = true }
            ))
            .font(.system(size: 15))
            .multilineTextAlignment(.trailing)
        }
        .padding(.horizontal, 16)
        .frame(minHeight: 46)
        .background(Color.xFill2, in: RoundedRectangle(cornerRadius: 26))
    }

    private func kvRow<Value: View>(_ key: String, @ViewBuilder value: () -> Value) -> some View {
        HStack {
            Text(key)
                .font(.system(size: 15))
                .foregroundStyle(Color.xText2)
                .frame(width: 74, alignment: .leading)
            Spacer(minLength: 12)
            value()
        }
        .frame(minHeight: 46)
    }
}
