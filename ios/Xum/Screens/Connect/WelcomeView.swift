import SwiftUI
import UIKit

/// Connect B: first-run welcome, shown when no servers are saved. At regular width (Duo inner)
/// the scanner sits beside the welcome column instead of behind a button tap.
struct WelcomeView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.horizontalSizeClass) private var sizeClass
    @State private var flow = ConnectScanModel()
    @State private var checkedClipboard = false

    var body: some View {
        Group {
            if sizeClass == .regular {
                HStack(spacing: 16) {
                    welcomeColumn
                        .frame(maxWidth: 420)
                    ScannerCore(chrome: .embedded, flow: flow)
                }
                .padding(16)
            } else {
                // The Duo outer screen is short; scroll rather than truncate when the column won't fit.
                ViewThatFits(in: .vertical) {
                    compactColumn
                    ScrollView { compactColumn }
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.xBg2)
        .onAppear(perform: checkClipboard)
    }

    private var compactColumn: some View {
        welcomeColumn
            .frame(maxWidth: .infinity)
            .padding(.horizontal, 24)
            .padding(.top, 24)
            .padding(.bottom, 16)
    }

    private var welcomeColumn: some View {
        VStack(alignment: .leading, spacing: 0) {
            Wordmark(size: 44)
            Text("Connect to your Xum server")
                .font(.xLargeTitle)
                .foregroundStyle(Color.xText)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 36)
            Text("Agents run on your computer or dev box. This app steers them over your network, and nothing runs on the phone.")
                .font(.system(size: 16))
                .foregroundStyle(Color.xText2)
                .lineSpacing(3)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 10)
            steps
                .padding(.top, 28)
            Spacer(minLength: 24)
            buttons
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var steps: some View {
        VStack(spacing: 0) {
            stepRow("01", step1)
            Divider().padding(.leading, 58)
            stepRow("02", Text("Settings › Server Access › Pair device"))
            Divider().padding(.leading, 58)
            stepRow("03", step3)
        }
        .background(Color.xCell, in: RoundedRectangle(cornerRadius: 26))
    }

    private var step1: some View {
        Text("Run ")
            + Text("xum server").font(.xMono(14)).foregroundStyle(Color.xCode)
            + Text(" or open Xum on desktop")
    }

    @ViewBuilder
    private var step3: some View {
        if sizeClass == .regular {
            Text("Hold the code up to the camera")
        } else {
            Text("Scan the code, or paste its link here")
        }
    }

    private func stepRow(_ number: String, _ content: some View) -> some View {
        HStack(spacing: 12) {
            Text(number)
                .font(.xMono(13, weight: .medium))
                .foregroundStyle(Color.xAccent)
                .frame(width: 30, alignment: .leading)
            content
                .font(.system(size: 16))
                .foregroundStyle(Color.xText)
                .multilineTextAlignment(.leading)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .frame(minHeight: 58)
    }

    private var buttons: some View {
        VStack(spacing: 12) {
            Button { model.sheet = .scanner } label: {
                Label("Scan QR Code", systemImage: "qrcode.viewfinder")
                    .font(.system(size: 17, weight: .semibold))
                    .frame(maxWidth: .infinity)
                    .frame(height: 56)
            }
            .buttonStyle(.glassProminent)
            Button { model.sheet = .connectLink(prefill: nil) } label: {
                Label("Enter Connection Link", systemImage: "link")
                    .font(.system(size: 17, weight: .semibold))
                    .frame(maxWidth: .infinity)
                    .frame(height: 56)
            }
            .buttonStyle(.glass)
            Text("https://host:3000/?token=…")
                .font(.xMono(12))
                .foregroundStyle(Color.xText3)
                .frame(maxWidth: .infinity)
                .padding(.top, 6)
        }
    }

    /// Connect C opens itself when the clipboard already holds a Xum link.
    private func checkClipboard() {
        guard !checkedClipboard, model.sheet == nil else { return }
        checkedClipboard = true
        guard let raw = UIPasteboard.general.url?.absoluteString ?? UIPasteboard.general.string,
              ConnectionLink.parse(raw) != nil else { return }
        model.sheet = .connectLink(prefill: raw)
    }
}
