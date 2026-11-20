import PDFKit
import SwiftUI
import WebKit

/// The desktop right sidebar on the phone: Stats (context, cost, timing), Artifacts and Changes.
/// A sheet on compact width; the chat's side column on the Duo's inner display.
struct WorkspaceInfoView: View {
    let store: WorkspaceInfoStore
    let chat: ChatStore?
    var onClose: () -> Void

    @State private var tab: Tab = .stats
    /// Pages are pushed in this view rather than a NavigationStack: a nested stack in the Duo's
    /// detail column takes over (and hides) the chat's navigation bar.
    @State private var detail: Detail?

    enum Tab: String, CaseIterable {
        case stats = "Stats"
        case artifacts = "Artifacts"
        case changes = "Changes"
    }

    enum Detail: Hashable {
        case artifact(ArtifactEntry)
        case file(ChangedFile)

        var title: String {
            switch self {
            case .artifact(let e): (e.path as NSString).lastPathComponent
            case .file(let f): (f.path as NSString).lastPathComponent
            }
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            if let detail {
                Group {
                    switch detail {
                    case .artifact(let e): ArtifactPreview(store: store, entry: e)
                    case .file(let f): FileDiffView(store: store, file: f)
                    }
                }
                .id(detail)
                .transition(.move(edge: .trailing))
            } else {
                SegmentedTabs(options: Tab.allCases.map(\.rawValue), selection: Binding(
                    get: { Tab.allCases.firstIndex(of: tab) ?? 0 },
                    set: { tab = Tab.allCases[$0] }
                ))
                .padding(.horizontal, 16)
                .padding(.vertical, 8)
                ScrollView {
                    Group {
                        switch tab {
                        case .stats: StatsTab(store: store, chat: chat)
                        case .artifacts: ArtifactsTab(store: store) { open(.artifact($0)) }
                        case .changes: ChangesTab(store: store) { open(.file($0)) }
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.bottom, 24)
                }
                .refreshable { await refresh() }
                .task(id: tab) { await refresh() }
            }
        }
        .frame(maxHeight: .infinity, alignment: .top)
        .background(Color.xBg2)
    }

    private func open(_ d: Detail) { withAnimation(.easeOut(duration: 0.2)) { detail = d } }

    private var header: some View {
        HStack(spacing: 8) {
            if detail != nil {
                Button { withAnimation(.easeOut(duration: 0.2)) { detail = nil } } label: {
                    Image(systemName: "chevron.left").font(.system(size: 15, weight: .semibold))
                        .frame(width: 32, height: 32).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .foregroundStyle(Color.xAccent)
                .accessibilityLabel("Back")
            }
            Text(detail?.title ?? "Workspace")
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(Color.xText)
                .lineLimit(1)
                .truncationMode(.middle)
            Spacer(minLength: 8)
            if case .artifact? = detail, let shareText = store.lastReadText {
                ShareLink(item: shareText) {
                    Image(systemName: "square.and.arrow.up").font(.system(size: 14, weight: .semibold))
                        .frame(width: 32, height: 32)
                }
                .foregroundStyle(Color.xText2)
            }
            Button(action: onClose) {
                Image(systemName: "xmark").font(.system(size: 13, weight: .semibold))
                    .frame(width: 32, height: 32).background(Color.xFill2, in: Circle())
            }
            .buttonStyle(.plain)
            .foregroundStyle(Color.xText2)
            .accessibilityLabel("Close")
        }
        .padding(.horizontal, 16)
        .padding(.top, 12)
        .padding(.bottom, 4)
    }

    private func refresh() async {
        switch tab {
        case .stats: await store.loadUsage()
        case .artifacts: await store.loadArtifacts()
        case .changes: await store.loadChanges()
        }
    }
}

// MARK: - Shared pieces

private struct InfoSection<Content: View>: View {
    let title: String
    var trailing: String?
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(title.uppercased()).font(.system(size: 12, weight: .semibold)).foregroundStyle(Color.xText3)
                Spacer()
                if let trailing { Text(trailing).font(.system(size: 12)).foregroundStyle(Color.xText3) }
            }
            .padding(.horizontal, 4)
            VStack(alignment: .leading, spacing: 0) { content }
                .padding(.vertical, 4)
                .background(Color.xCell, in: RoundedRectangle(cornerRadius: 14))
        }
        .padding(.top, 14)
    }
}

private struct InfoRow: View {
    let label: String
    let value: String
    var detail: String?
    var mono = true

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(label).font(.system(size: 15)).foregroundStyle(Color.xText)
            Spacer(minLength: 12)
            if let detail { Text(detail).font(.system(size: 13)).foregroundStyle(Color.xText3) }
            Text(value)
                .font(mono ? .xMono(14) : .system(size: 15))
                .foregroundStyle(Color.xText)
                .monospacedDigit()
        }
        .padding(.horizontal, 14)
        .frame(minHeight: 40)
    }
}

private struct EmptyNote: View {
    let icon: String
    let text: String

    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: icon).font(.system(size: 26)).foregroundStyle(Color.xText3)
            Text(text).font(.system(size: 14)).foregroundStyle(Color.xText2).multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 40)
        .padding(.horizontal, 20)
    }
}

enum InfoFormat {
    static func tokens(_ n: Int) -> String {
        if n >= 1_000_000 { return String(format: "%.1fM", Double(n) / 1_000_000) }
        if n >= 10_000 { return "\(n / 1000)k" }
        if n >= 1000 { return String(format: "%.1fk", Double(n) / 1000) }
        return "\(n)"
    }

    static func cost(_ c: Double) -> String {
        if c == 0 { return "$0.00" }
        if c < 0.01 { return "<$0.01" }
        return String(format: "$%.2f", c)
    }

    static func ms(_ v: Double?) -> String {
        guard let v else { return "–" }
        if v < 1000 { return "\(Int(v)) ms" }
        if v < 60_000 { return String(format: "%.1fs", v / 1000) }
        return ChatFormat.duration(v / 1000)
    }

    static func bytes(_ n: Int) -> String { ByteCountFormatter.string(fromByteCount: Int64(n), countStyle: .file) }
}

// MARK: - Stats

private struct StatsTab: View {
    let store: WorkspaceInfoStore
    let chat: ChatStore?

    /// Same budget as the composer's context ring.
    private var contextLimit: Int { ModelName.contextWindow(store.contextModel ?? chat?.lastModel) }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let tokens = store.contextTokens ?? chat?.contextTokens {
                InfoSection(title: "Context", trailing: store.contextModel.map(ModelName.display)) {
                    VStack(alignment: .leading, spacing: 8) {
                        HStack(alignment: .firstTextBaseline) {
                            Text(InfoFormat.tokens(tokens)).font(.xMono(22, weight: .semibold)).foregroundStyle(Color.xText)
                            Text("of \(InfoFormat.tokens(contextLimit)) tokens").font(.system(size: 13)).foregroundStyle(Color.xText2)
                            Spacer()
                            Text("\(Int(fraction(tokens) * 100))%").font(.xMono(14)).foregroundStyle(tint(tokens))
                        }
                        ProgressView(value: fraction(tokens)).tint(tint(tokens))
                    }
                    .padding(14)
                }
            }
            InfoSection(title: "Cost", trailing: store.hasUnknownCosts ? "some prices unknown" : nil) {
                if !store.usageLoaded {
                    ProgressView().frame(maxWidth: .infinity).padding(20)
                } else if store.usage.isEmpty {
                    InfoRow(label: "No usage yet", value: "")
                } else {
                    InfoRow(label: "Session", value: InfoFormat.cost(store.totalCost))
                    ForEach(store.usage) { u in
                        Divider().padding(.leading, 14)
                        ModelUsageRow(usage: u)
                    }
                }
            }
            if let t = store.timing {
                if let last = t.last {
                    InfoSection(title: "Last response", trailing: last.model.map(ModelName.display)) {
                        InfoRow(label: "Total", value: InfoFormat.ms(last.totalMs))
                        InfoRow(label: "Time to first token", value: InfoFormat.ms(last.ttftMs))
                        InfoRow(label: "Model", value: InfoFormat.ms(last.modelMs))
                        InfoRow(label: "Tools", value: InfoFormat.ms(last.toolMs))
                        if let tps = last.tokensPerSecond {
                            InfoRow(label: "Output speed", value: String(format: "%.0f tok/s", tps))
                        }
                    }
                }
                InfoSection(title: "Session timing") {
                    InfoRow(label: "Responses", value: "\(t.responses)")
                    InfoRow(label: "Total time", value: InfoFormat.ms(t.sessionMs))
                    InfoRow(label: "Tool time", value: InfoFormat.ms(t.sessionToolMs))
                    InfoRow(label: "Avg. first token", value: InfoFormat.ms(t.avgTtftMs))
                    InfoRow(label: "Output tokens", value: InfoFormat.tokens(t.sessionOutputTokens))
                }
            }
        }
        .task { await store.followTiming() }
        // A finished turn changes the totals.
        .onChange(of: chat?.isStreaming) { _, streaming in
            if streaming == false { Task { await store.loadUsage() } }
        }
    }

    private func fraction(_ t: Int) -> Double { min(1, Double(t) / Double(contextLimit)) }
    private func tint(_ t: Int) -> Color { fraction(t) > 0.85 ? .xBad : fraction(t) > 0.6 ? .xWarn : .xAccent }
}

private struct ModelUsageRow: View {
    let usage: ModelUsage
    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button { withAnimation(.easeOut(duration: 0.2)) { expanded.toggle() } } label: {
                HStack {
                    Text(ModelName.display(usage.model)).font(.system(size: 15)).foregroundStyle(Color.xText)
                    Spacer(minLength: 12)
                    Text(InfoFormat.tokens(usage.totalTokens) + " tok").font(.system(size: 13)).foregroundStyle(Color.xText3)
                    Text(usage.hasUnknownCosts && usage.cost == 0 ? "–" : InfoFormat.cost(usage.cost))
                        .font(.xMono(14)).foregroundStyle(Color.xText).monospacedDigit()
                    Image(systemName: expanded ? "chevron.up" : "chevron.down").font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(Color.xText3)
                }
                .padding(.horizontal, 14)
                .frame(minHeight: 40)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if expanded {
                ForEach(usage.buckets.filter { $0.1.tokens > 0 }, id: \.0) { name, b in
                    HStack {
                        Text(name).font(.system(size: 13)).foregroundStyle(Color.xText2)
                        Spacer()
                        Text(InfoFormat.tokens(b.tokens)).font(.xMono(12)).foregroundStyle(Color.xText2)
                        Text(b.cost.map(InfoFormat.cost) ?? "–").font(.xMono(12)).foregroundStyle(Color.xText3)
                            .frame(minWidth: 56, alignment: .trailing)
                    }
                    .padding(.horizontal, 14)
                    .padding(.leading, 12)
                    .frame(minHeight: 28)
                }
                .padding(.bottom, 6)
            }
        }
    }
}

// MARK: - Artifacts

private struct ArtifactsTab: View {
    let store: WorkspaceInfoStore
    let onOpen: (ArtifactEntry) -> Void

    var body: some View {
        Group {
            if !store.artifactsLoaded {
                ProgressView().frame(maxWidth: .infinity).padding(40)
            } else if let reason = store.artifactsUnavailable {
                EmptyNote(icon: "doc.richtext", text: reason)
            } else if store.artifacts.isEmpty {
                EmptyNote(icon: "doc.richtext", text: "No artifacts yet. Files the agent writes to $XUM_SCRATCH_DIR/artifacts show up here.")
            } else {
                InfoSection(title: "\(store.artifacts.count) \(store.artifacts.count == 1 ? "file" : "files")") {
                    ForEach(Array(store.artifacts.enumerated()), id: \.element.id) { i, entry in
                        if i > 0 { Divider().padding(.leading, 52) }
                        Button { onOpen(entry) } label: { ArtifactRow(entry: entry) }
                            .buttonStyle(.plain)
                    }
                }
            }
        }
        // The agent may write more while the panel is open (desktop polls every 3 s too).
        .task {
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(3))
                if Task.isCancelled { break }
                await store.loadArtifacts()
            }
        }
    }
}

private struct ArtifactRow: View {
    let entry: ArtifactEntry

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: ArtifactKind.icon(entry.kind))
                .font(.system(size: 15))
                .foregroundStyle(Color.xAccent)
                .frame(width: 26)
            VStack(alignment: .leading, spacing: 2) {
                Text((entry.path as NSString).lastPathComponent).font(.system(size: 15)).foregroundStyle(Color.xText).lineLimit(1)
                Text(subtitle).font(.system(size: 12)).foregroundStyle(Color.xText3).lineLimit(1)
            }
            Spacer(minLength: 8)
            Image(systemName: "chevron.right").font(.system(size: 12, weight: .semibold)).foregroundStyle(Color.xText3)
        }
        .padding(.horizontal, 14)
        .frame(minHeight: 52)
        .contentShape(Rectangle())
    }

    private var subtitle: String {
        let dir = (entry.path as NSString).deletingLastPathComponent
        let when = entry.modified.formatted(.relative(presentation: .named))
        return [dir.isEmpty ? nil : dir, InfoFormat.bytes(entry.size), when].compactMap { $0 }.joined(separator: " · ")
    }
}

enum ArtifactKind {
    static func icon(_ kind: String) -> String {
        switch kind {
        case "markdown": "doc.text"
        case "json": "curlybraces"
        case "image": "photo"
        case "html": "globe"
        case "svg": "scribble.variable"
        case "csv": "tablecells"
        case "mermaid": "point.3.connected.trianglepath.dotted"
        case "diff": "plusminus"
        case "pdf": "doc.richtext"
        case "canvas": "rectangle.on.rectangle"
        default: "doc.plaintext"
        }
    }
}

private struct ArtifactPreview: View {
    let store: WorkspaceInfoStore
    let entry: ArtifactEntry

    @State private var content: ArtifactContent?
    @State private var error: String?
    @State private var pdf: PDFDocument?

    var body: some View {
        Group {
            if let error {
                EmptyNote(icon: "exclamationmark.triangle", text: error)
            } else if let content {
                rendered(content)
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .background(Color.xBg)
        .task {
            do { content = try await store.readArtifact(entry.path) } catch { self.error = error.localizedDescription }
        }
    }

    @ViewBuilder private func rendered(_ c: ArtifactContent) -> some View {
        switch c {
        case .tooLarge(let size):
            EmptyNote(icon: "doc", text: "\(entry.path) is \(InfoFormat.bytes(size)), too large to preview here.")
        case .binary:
            EmptyNote(icon: "doc", text: "\(entry.path) is a binary file.")
        case .image(let data):
            if entry.kind == "pdf", let doc = PDFDocument(data: data) {
                PDFKitView(document: doc)
            } else if let image = UIImage(data: data) {
                ScrollView([.horizontal, .vertical]) {
                    Image(uiImage: image).resizable().scaledToFit().containerRelativeFrame(.horizontal)
                }
            } else {
                EmptyNote(icon: "photo", text: "This image could not be decoded.")
            }
        case .text(let text):
            switch entry.kind {
            case "markdown":
                ScrollView { AssistantTextView(text: text).padding(16).frame(maxWidth: .infinity, alignment: .leading) }
            case "html", "svg", "canvas":
                SandboxedWebView(html: entry.kind == "svg" ? svgPage(text) : text)
            case "json":
                ScrollView { mono(JSONValue.parse(Data(text.utf8))?.prettyString ?? text) }
            default:
                ScrollView { mono(text) }
            }
        }
    }

    private func mono(_ text: String) -> some View {
        ScrollView(.horizontal) {
            Text(text).font(.xMono(12.5)).foregroundStyle(Color.xText).textSelection(.enabled).padding(16)
        }
    }

    private func svgPage(_ svg: String) -> String {
        "<!doctype html><meta name=viewport content='width=device-width'><style>body{margin:0;display:flex;justify-content:center}svg{max-width:100%;height:auto}</style>" + svg
    }
}

private struct PDFKitView: UIViewRepresentable {
    let document: PDFDocument
    func makeUIView(context: Context) -> PDFView {
        let v = PDFView()
        v.autoScales = true
        v.document = document
        return v
    }
    func updateUIView(_ v: PDFView, context: Context) {}
}

/// HTML/SVG artifacts are agent-written, so they render with no network access (every http(s)
/// load is blocked by a content rule, as the desktop's CSP does) and cannot navigate away.
struct SandboxedWebView: UIViewRepresentable {
    let html: String

    private static let blockNetwork = #"[{"trigger":{"url-filter":"^https?://"},"action":{"type":"block"}},{"trigger":{"url-filter":"^wss?://"},"action":{"type":"block"}}]"#

    /// SECURITY AUDIT: content rules do not cover WebRTC, whose ICE traffic (STUN/TURN) can reach
    /// any host, so every RTC global is deleted before any artifact script runs, in every frame
    /// (WebKit runs it in a script-made about:blank frame too; ArtifactSandboxTests checks both),
    /// as the desktop artifact bridge does. `frame-src`/`child-src 'none'` matches the desktop's
    /// frame policy as a second layer; CSP policies intersect, so the artifact cannot loosen it.
    static let noWebRTC = """
    (() => { for (const k of Object.getOwnPropertyNames(window)) { if (/^(webkit)?RTC/.test(k)) { try { delete window[k]; } catch (e) {} } } })();
    """
    static let noFramesPolicy = #"<meta http-equiv="Content-Security-Policy" content="frame-src 'none'; child-src 'none'">"#

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> WKWebView {
        Self.load(html, delegate: context.coordinator)
    }

    /// Builds the locked-down view and loads `html` once the network rule is in place.
    static func load(_ html: String, delegate: WKNavigationDelegate) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.userContentController.addUserScript(WKUserScript(source: noWebRTC, injectionTime: .atDocumentStart, forMainFrameOnly: false))
        let view = WKWebView(frame: .zero, configuration: config)
        view.navigationDelegate = delegate
        view.isOpaque = false
        WKContentRuleListStore.default().compileContentRuleList(forIdentifier: "xum-artifact-offline", encodedContentRuleList: blockNetwork) { list, _ in
            // Never load the page without the rule: an error leaves the view empty.
            guard let list else { return }
            config.userContentController.add(list)
            view.loadHTMLString(withPolicy(html), baseURL: nil)
        }
        return view
    }

    /// The policy goes after a doctype, never before it: text ahead of the doctype would put the
    /// page in quirks mode.
    static func withPolicy(_ html: String) -> String {
        let lead = html.prefix(while: \.isWhitespace)
        let rest = html.dropFirst(lead.count)
        guard rest.lowercased().hasPrefix("<!doctype"), let end = rest.firstIndex(of: ">") else { return noFramesPolicy + html }
        return String(rest[...end]) + noFramesPolicy + String(rest[rest.index(after: end)...])
    }

    func updateUIView(_ v: WKWebView, context: Context) {}

    final class Coordinator: NSObject, WKNavigationDelegate {
        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
            action.navigationType == .other ? .allow : .cancel
        }
    }
}

// MARK: - Changes

private struct ChangesTab: View {
    let store: WorkspaceInfoStore
    let onOpen: (ChangedFile) -> Void

    var body: some View {
        if !store.changesLoaded {
            ProgressView().frame(maxWidth: .infinity).padding(40)
        } else if let error = store.changesError {
            EmptyNote(icon: "exclamationmark.triangle", text: error)
        } else if store.changes.isEmpty {
            EmptyNote(icon: "checkmark.circle", text: "No changes against the base branch.")
        } else {
            let added = store.changes.reduce(0) { $0 + $1.added }
            let removed = store.changes.reduce(0) { $0 + $1.removed }
            InfoSection(title: "\(store.changes.count) \(store.changes.count == 1 ? "file" : "files") · +\(added) −\(removed)", trailing: store.changesBase.map { "vs \($0)" }) {
                ForEach(Array(store.changes.enumerated()), id: \.element.id) { i, f in
                    if i > 0 { Divider().padding(.leading, 14) }
                    Button { onOpen(f) } label: { ChangeRow(file: f) }.buttonStyle(.plain)
                }
            }
        }
    }
}

private struct ChangeRow: View {
    let file: ChangedFile

    var body: some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text((file.path as NSString).lastPathComponent).font(.xMono(14)).foregroundStyle(Color.xText).lineLimit(1)
                let dir = (file.path as NSString).deletingLastPathComponent
                if !dir.isEmpty || file.untracked {
                    Text([dir.isEmpty ? nil : dir, file.untracked ? "new" : nil].compactMap { $0 }.joined(separator: " · "))
                        .font(.system(size: 12)).foregroundStyle(Color.xText3).lineLimit(1).truncationMode(.head)
                }
            }
            Spacer(minLength: 8)
            Text("+\(file.added)").font(.xMono(12)).foregroundStyle(Color.xOk)
            Text("−\(file.removed)").font(.xMono(12)).foregroundStyle(Color.xBad)
            Image(systemName: "chevron.right").font(.system(size: 12, weight: .semibold)).foregroundStyle(Color.xText3)
        }
        .padding(.horizontal, 14)
        .frame(minHeight: 50)
        .contentShape(Rectangle())
    }
}

private struct FileDiffView: View {
    let store: WorkspaceInfoStore
    let file: ChangedFile

    @State private var lines: [String]?
    @State private var error: String?

    var body: some View {
        Group {
            if let error {
                EmptyNote(icon: "exclamationmark.triangle", text: error)
            } else if let lines {
                ScrollView([.vertical, .horizontal]) {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(Array(lines.enumerated()), id: \.offset) { _, line in row(line) }
                    }
                    .padding(.vertical, 8)
                }
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .background(Color.xCodeBg)
        .task {
            do {
                let out = try await store.diff(file)
                // Skip git's header lines; the hunks carry the content.
                let all = out.components(separatedBy: "\n")
                lines = Array(all[(all.firstIndex { $0.hasPrefix("@@") } ?? all.endIndex)...])
                if lines?.isEmpty == true { lines = ["(no textual changes)"] }
            } catch { self.error = error.localizedDescription }
        }
    }

    private func row(_ line: String) -> some View {
        let isHunk = line.hasPrefix("@@")
        let add = line.hasPrefix("+"), del = line.hasPrefix("-")
        return Text(isHunk ? AttributedString(line) : Syntax.highlight(line.isEmpty ? " " : line))
            .font(.xMono(12.5))
            .foregroundStyle(isHunk ? Color.xThink : Color.xText)
            .padding(.horizontal, 12)
            .frame(minWidth: 600, minHeight: 20, alignment: .leading)
            .background(add ? Color.xDiffAdd : del ? Color.xDiffDel : Color.clear)
    }
}
