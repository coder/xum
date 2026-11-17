import SwiftUI

/// Inbox tab: every workspace that is waiting on you (question, plan ready) or failed.
struct InboxView: View {
    @Environment(AppModel.self) private var model

    private struct Entry: Identifiable {
        let id: String
        let workspace: Workspace
        let attention: Attention
        let recency: Date?
    }

    private var entries: [Entry] {
        guard let list = model.list else { return [] }
        return list.attention.compactMap { id, attention in
            guard let w = list.workspace(id) else { return nil }
            return Entry(id: id, workspace: w, attention: attention, recency: list.activity[id]?.recency ?? w.createdAt)
        }
        .sorted { ($0.recency ?? .distantPast) > ($1.recency ?? .distantPast) }
    }

    var body: some View {
        Group {
            if entries.isEmpty {
                ContentUnavailableView("Nothing needs you", systemImage: "tray")
            } else {
                List(entries) { entry in
                    row(entry)
                }
                .listStyle(.plain)
                .scrollContentBackground(.hidden)
            }
        }
        .background(Color.xBg2.ignoresSafeArea())
        .navigationTitle("Inbox")
    }

    private func row(_ entry: Entry) -> some View {
        Button {
            model.open(entry.id)
        } label: {
            HStack(spacing: 12) {
                StatusIcon(streaming: false, attention: entry.attention, todosDone: false)
                VStack(alignment: .leading, spacing: 2) {
                    Text(entry.workspace.displayName)
                        .font(.xMono(15, weight: .semibold))
                        .foregroundStyle(Color.xText)
                        .lineLimit(1)
                    Text(detail(entry))
                        .font(.system(size: 14))
                        .foregroundStyle(entry.attention.isWaiting ? Color.xWarn : Color.xBad)
                        .lineLimit(2)
                }
                Spacer(minLength: 8)
                Text(RelativeTime.short(entry.recency))
                    .font(.system(size: 13))
                    .foregroundStyle(Color.xText3)
            }
            .padding(.horizontal, 16)
            .frame(minHeight: 66)
        }
        .buttonStyle(.plain)
        .listRowInsets(EdgeInsets())
        .listRowSeparator(.hidden)
        .listRowBackground(RoundedRectangle(cornerRadius: 26, style: .continuous).fill(Color.xCell))
    }

    private func detail(_ entry: Entry) -> String {
        switch entry.attention {
        case .question(let q):
            q.isEmpty ? "Question" : "Question · \(q)"
        case .planReady: "Plan ready"
        case .error(let m): m
        }
    }
}
