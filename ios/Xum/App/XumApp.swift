import SwiftUI

@main
struct XumApp: App {
    @State private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .tint(Color.xAccent)
                .onOpenURL { model.handle(url: $0) }
        }
    }
}
