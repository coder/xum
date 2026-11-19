import SwiftUI
import AVFoundation
import PhotosUI
import CoreImage

/// Shared connect-from-scan state for the full-screen scanner and the regular-width welcome panel.
@Observable
final class ConnectScanModel {
    var link: ConnectionLink?
    var connecting = false

    /// First QR payload that parses as a Xum link wins; later codes are ignored until reset.
    func handleCode(_ raw: String) {
        guard link == nil, let l = ConnectionLink.parse(raw) else { return }
        link = l
    }

    /// Probes `/version` for the saved version label, then hands off to `AppModel.addServer`.
    func connect(name: String?, model: AppModel) async {
        guard let link, !connecting else { return }
        // A plain-HTTP link needs the user's explicit OK, which the link sheet asks for.
        guard link.isProtectedTransport else {
            model.sheet = .connectLink(prefill: link.urlString)
            return
        }
        connecting = true
        defer { connecting = false }
        var version: String?
        if let (v, _) = try? await APIClient.probe(link.baseURL) { version = v.short }
        model.addServer(link, name: name ?? link.suggestedName, version: version)
    }
}

/// AVCaptureSession wrapper. `nonisolated`: the session is configured and run on its own queue;
/// findings are forwarded to the given MainActor callbacks.
nonisolated final class QRCamera: NSObject, AVCaptureMetadataOutputObjectsDelegate, @unchecked Sendable {
    let session = AVCaptureSession()
    private let sessionQueue = DispatchQueue(label: "xum.qr-camera")
    private let output = AVCaptureMetadataOutput()
    private var started = false
    var onCode: (@MainActor (String) -> Void)?
    var onUnavailable: (@MainActor () -> Void)?

    func start() {
        sessionQueue.async {
            guard !self.started else { return }
            self.started = true
            switch AVCaptureDevice.authorizationStatus(for: .video) {
            case .authorized:
                self.configure()
            case .notDetermined:
                AVCaptureDevice.requestAccess(for: .video) { granted in
                    if granted {
                        self.sessionQueue.async { self.configure() }
                    } else {
                        Task { @MainActor in self.onUnavailable?() }
                    }
                }
            default:
                Task { @MainActor in self.onUnavailable?() }
            }
        }
    }

    func stop() {
        sessionQueue.async {
            if self.session.isRunning { self.session.stopRunning() }
            self.started = false
        }
    }

    func setTorch(_ on: Bool) {
        sessionQueue.async {
            guard let device = AVCaptureDevice.default(for: .video), device.hasTorch else { return }
            try? device.lockForConfiguration()
            device.torchMode = on ? .on : .off
            device.unlockForConfiguration()
        }
    }

    private func configure() {
        session.beginConfiguration()
        session.sessionPreset = .hd1920x1080
        guard let device = AVCaptureDevice.default(for: .video),
              let input = try? AVCaptureDeviceInput(device: device),
              session.canAddInput(input), session.canAddOutput(output) else {
            session.commitConfiguration()
            Task { @MainActor in self.onUnavailable?() }
            return
        }
        session.addInput(input)
        session.addOutput(output)
        output.metadataObjectTypes = [.qr]
        output.setMetadataObjectsDelegate(self, queue: sessionQueue)
        session.commitConfiguration()
        session.startRunning()
    }

    func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput metadataObjects: [AVMetadataObject], from connection: AVCaptureConnection) {
        guard let code = metadataObjects.compactMap({ $0 as? AVMetadataMachineReadableCodeObject })
            .first(where: { $0.type == .qr })?.stringValue else { return }
        Task { @MainActor in self.onCode?(code) }
    }
}

/// Aspect-fill camera preview layer.
final class PreviewUIView: UIView {
    private let videoLayer = AVCaptureVideoPreviewLayer()

    override init(frame: CGRect) {
        super.init(frame: frame)
        videoLayer.videoGravity = .resizeAspectFill
        layer.addSublayer(videoLayer)
    }

    required init?(coder: NSCoder) { nil }

    override func layoutSubviews() {
        super.layoutSubviews()
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        videoLayer.frame = bounds
        CATransaction.commit()
    }
}

struct CameraPreviewView: UIViewRepresentable {
    let session: AVCaptureSession

    func makeUIView(context: Context) -> PreviewUIView {
        let v = PreviewUIView()
        if let l = v.layer.sublayers?.first as? AVCaptureVideoPreviewLayer { l.session = session }
        return v
    }

    func updateUIView(_ uiView: PreviewUIView, context: Context) {}
}

/// Four L-shaped corner strokes around the scan target.
private struct ScanBrackets: View {
    var size: CGFloat = 240
    var body: some View {
        ScanBracketShape()
            .stroke(Color.white, style: StrokeStyle(lineWidth: 5, lineCap: .round))
            .frame(width: size, height: size)
    }
}

nonisolated struct ScanBracketShape: Shape {
    func path(in rect: CGRect) -> Path {
        let r = rect.width * 0.115
        let arm = rect.width * 0.24
        var p = Path()
        // Drawn per corner: arm in, quarter arc, arm out.
        // Top left
        p.move(to: CGPoint(x: rect.minX, y: rect.minY + arm))
        p.addLine(to: CGPoint(x: rect.minX, y: rect.minY + r))
        p.addArc(center: CGPoint(x: rect.minX + r, y: rect.minY + r), radius: r, startAngle: .degrees(180), endAngle: .degrees(270), clockwise: false)
        p.addLine(to: CGPoint(x: rect.minX + arm, y: rect.minY))
        // Top right
        p.move(to: CGPoint(x: rect.maxX - arm, y: rect.minY))
        p.addLine(to: CGPoint(x: rect.maxX - r, y: rect.minY))
        p.addArc(center: CGPoint(x: rect.maxX - r, y: rect.minY + r), radius: r, startAngle: .degrees(270), endAngle: .degrees(0), clockwise: false)
        p.addLine(to: CGPoint(x: rect.maxX, y: rect.minY + arm))
        // Bottom right
        p.move(to: CGPoint(x: rect.maxX, y: rect.maxY - arm))
        p.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY - r))
        p.addArc(center: CGPoint(x: rect.maxX - r, y: rect.maxY - r), radius: r, startAngle: .degrees(0), endAngle: .degrees(90), clockwise: false)
        p.addLine(to: CGPoint(x: rect.maxX - arm, y: rect.maxY))
        // Bottom left
        p.move(to: CGPoint(x: rect.minX + arm, y: rect.maxY))
        p.addLine(to: CGPoint(x: rect.minX + r, y: rect.maxY))
        p.addArc(center: CGPoint(x: rect.minX + r, y: rect.maxY - r), radius: r, startAngle: .degrees(90), endAngle: .degrees(180), clockwise: false)
        p.addLine(to: CGPoint(x: rect.minX, y: rect.maxY - arm))
        return p
    }
}

/// Glass card shown over the viewfinder once a Xum link is scanned.
struct ScanResultCard: View {
    @Environment(AppModel.self) private var model
    let link: ConnectionLink
    var flow: ConnectScanModel

    private var hostDisplay: String {
        guard let port = link.port, port != 443, port != 80 else { return link.host }
        return "\(link.host):\(port)"
    }

    var body: some View {
        HStack(spacing: 12) {
            RoundedRectangle(cornerRadius: 24)
                .fill(Color.xAccentFill)
                .frame(width: 48, height: 48)
                .overlay(Image(systemName: "server.rack").font(.system(size: 20)).foregroundStyle(.white))
            VStack(alignment: .leading, spacing: 2) {
                Text(link.suggestedName)
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(Color.xText)
                Text(hostDisplay)
                    .font(.xMono(12.5))
                    .foregroundStyle(Color.xText2)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            Spacer(minLength: 8)
            Button {
                Task { await flow.connect(name: nil, model: model) }
            } label: {
                Group {
                    if flow.connecting { ProgressView().controlSize(.regular) } else { Text("Connect") }
                }
                .font(.system(size: 16, weight: .semibold))
                .frame(minWidth: 96, minHeight: 48)
            }
            .buttonStyle(.glassProminent)
        }
        .padding(12)
        .frame(minHeight: 76)
        .glassRect(38)
    }
}

enum ScannerChrome { case fullscreen, embedded }

/// Camera viewfinder with brackets, torch and the scanned-link card. `fullscreen` adds the
/// wordmark capsule, close button and bottom explainer panel; `embedded` is the regular-width
/// welcome screen's right-hand live camera panel.
struct ScannerCore: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    var chrome: ScannerChrome
    var flow: ConnectScanModel

    @State private var camera = QRCamera()
    @State private var torchOn = false
    @State private var unavailable = false
    @State private var photoItem: PhotosPickerItem?

    var body: some View {
        ZStack {
            Color.xCam
            if !unavailable {
                CameraPreviewView(session: camera.session)
            }
            if unavailable {
                VStack(spacing: 10) {
                    Image(systemName: "camera.badge.ellipsis").font(.system(size: 30, weight: .light))
                    Text("Camera unavailable").font(.system(size: 15))
                }
                .foregroundStyle(Color.white.opacity(0.7))
            }
            ScanBrackets().allowsHitTesting(false)
            if let link = flow.link {
                ScanResultCard(link: link, flow: flow)
                    .padding(.horizontal, chrome == .fullscreen ? 16 : 14)
                    .frame(maxHeight: .infinity, alignment: .bottom)
                    .padding(.bottom, chrome == .fullscreen ? 264 : 96)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
            chromeOverlay
        }
        .clipShape(RoundedRectangle(cornerRadius: chrome == .embedded ? 28 : 0))
        .animation(.spring(duration: 0.35), value: flow.link)
        .onAppear(perform: startCamera)
        .onDisappear {
            camera.setTorch(false)
            camera.stop()
        }
        .onChange(of: torchOn) { _, on in camera.setTorch(on) }
        .onChange(of: photoItem) { _, item in
            Task { await detectPhoto(item) }
        }
    }

    private func startCamera() {
        unavailable = AVCaptureDevice.default(for: .video) == nil
        camera.onCode = { flow.handleCode($0) }
        camera.onUnavailable = { unavailable = true }
        camera.start()
    }

    /// Detects a QR code in the picked screenshot with CoreImage.
    private func detectPhoto(_ item: PhotosPickerItem?) async {
        guard let item else { return }
        guard let data = try? await item.loadTransferable(type: Data.self),
              let image = UIImage(data: data), let ci = CIImage(image: image),
              let detector = CIDetector(ofType: CIDetectorTypeQRCode, context: nil,
                                       options: [CIDetectorAccuracy: CIDetectorAccuracyHigh]) else { return }
        let codes = detector.features(in: ci).compactMap { ($0 as? CIQRCodeFeature)?.messageString }
        for code in codes where ConnectionLink.parse(code) != nil {
            flow.handleCode(code)
            break
        }
    }

    @ViewBuilder
    private var chromeOverlay: some View {
        switch chrome {
        case .fullscreen:
            VStack(spacing: 0) {
                HStack(spacing: 12) {
                    HStack(spacing: 8) {
                        Wordmark(size: 19)
                        Spacer(minLength: 8)
                        Button { dismiss() } label: {
                            Image(systemName: "xmark")
                                .font(.system(size: 14, weight: .semibold))
                                .frame(width: 32, height: 32)
                                .background(Color.xFill2, in: Circle())
                        }
                    }
                    .padding(.leading, 16)
                    .padding(.trailing, 6)
                    .frame(height: 44)
                    .glassCapsule()
                    Spacer()
                    torchButton
                }
                .padding(.horizontal, 20)
                .padding(.top, 8)
                Spacer()
                bottomPanel
                    .padding(.horizontal, 14)
                    .padding(.bottom, 14)
            }
        case .embedded:
            VStack {
                HStack {
                    Text("Scan pairing code")
                        .font(.xCaption)
                        .kerning(0.4)
                        .foregroundStyle(Color.white.opacity(0.8))
                    Spacer()
                    torchButton
                }
                Spacer()
                HStack(spacing: 8) {
                    Image(systemName: "qrcode.viewfinder").font(.system(size: 13))
                    Text("Point at the code in Server Access").font(.system(size: 14))
                }
                .foregroundStyle(Color.white)
                .padding(.horizontal, 16)
                .frame(height: 40)
                .background(Color.white.opacity(0.14), in: Capsule())
            }
            .padding(20)
        }
    }

    private var torchButton: some View {
        Button { torchOn.toggle() } label: {
            Image(systemName: torchOn ? "flashlight.on.fill" : "flashlight.off.fill")
                .font(.system(size: 17, weight: .medium))
                .foregroundStyle(Color.white)
                .frame(width: 44, height: 44)
        }
        .glassCircle()
        .opacity(unavailable ? 0 : 1)
        .disabled(unavailable)
    }

    private var bottomPanel: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("Scan the pairing code")
                .font(.system(size: 21, weight: .semibold))
                .foregroundStyle(Color.xText)
            Text("On your computer, open Xum › Settings › Server Access and choose Pair device.")
                .font(.system(size: 15))
                .foregroundStyle(Color.xText2)
                .padding(.top, 6)
            HStack(spacing: 10) {
                Button { model.sheet = .connectLink(prefill: nil) } label: {
                    Label("Enter connection link", systemImage: "link")
                        .font(.system(size: 16, weight: .semibold))
                        .frame(maxWidth: .infinity)
                        .frame(height: 52)
                }
                .buttonStyle(.glass)
                PhotosPicker(selection: $photoItem, matching: .images) {
                    Image(systemName: "photo")
                        .font(.system(size: 18))
                        .frame(width: 52, height: 52)
                }
                .buttonStyle(.glass)
            }
            .padding(.top, 20)
        }
        .padding(EdgeInsets(top: 26, leading: 22, bottom: 28, trailing: 22))
        .glassRect(42)
    }
}

/// Connect A: full-screen camera for pairing via QR code.
struct ScannerView: View {
    @State private var flow = ConnectScanModel()

    var body: some View {
        ScannerCore(chrome: .fullscreen, flow: flow)
            .ignoresSafeArea()
    }
}
