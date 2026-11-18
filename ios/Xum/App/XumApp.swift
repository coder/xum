import SwiftUI

@main
struct XumApp: App {
    @State private var model = AppModel()
    @AppStorage("xum.appearance") private var appearance = Appearance.system.rawValue

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .tint(Color.xAccent)
                .xumAppearance(Appearance(rawValue: appearance) ?? .system)
                .onOpenURL { model.handle(url: $0) }
                .background(HorizontalStatusBar().frame(width: 0, height: 0))
        }
    }
}
