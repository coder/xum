import SwiftUI

/// Search tab: filter the current server's workspaces by name or project.
struct SearchView: View {
    @Environment(AppModel.self) private var model
    @State private var query = ""

    private var results: [Workspace] {
        guard let list = model.list else { return [] }
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !q.isEmpty else { return list.workspaces }
        return list.workspaces.filter {
            $0.displayName.lowercased().contains(q)
                || $0.name.lowercased().contains(q)
                || $0.projectName.lowercased().contains(q)
                || $0.projectPath.lowercased().contains(q)
        }
    }

    var body: some View {
        Group {
            if results.isEmpty {
                ContentUnavailableView.search(text: query)
            } else {
                List(results) { w in
                    Button {
                        model.open(w.id)
                    } label: {
                        HStack(spacing: 12) {
                            Image(systemName: w.isScratch ? "message" : "arrow.triangle.branch")
                                .font(.system(size: 18))
                                .foregroundStyle(Color.xText3)
                                .frame(width: 20)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(w.displayName)
                                    .font(.xMono(15, weight: .medium))
                                    .foregroundStyle(Color.xText)
                                    .lineLimit(1)
                                Text(w.projectName)
                                    .font(.system(size: 14))
                                    .foregroundStyle(Color.xText2)
                                    .lineLimit(1)
                            }
                        }
                        .padding(.horizontal, 16)
                        .frame(minHeight: 60)
                    }
                    .buttonStyle(.plain)
                    .listRowInsets(EdgeInsets())
                    .listRowSeparator(.hidden)
                    .listRowBackground(RoundedRectangle(cornerRadius: 26, style: .continuous).fill(Color.xCell))
                }
                .listStyle(.plain)
                .scrollContentBackground(.hidden)
            }
        }
        .background(Color.xBg2.ignoresSafeArea())
        .navigationTitle("Search")
        .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Workspaces and projects")
    }
}
