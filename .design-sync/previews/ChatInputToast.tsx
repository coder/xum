import * as React from "react";
import { MuxPreviewShell } from "../preview-harness";
import { ChatInputToast } from "@/browser/features/ChatInput/ChatInputToast";

// Mirrors the LongNoticeOnPhone story: an error toast whose very long message (wide
// glyphs) scrolls inside the toast at phone width. wrap={false} renders the toast
// content without its absolute-positioned overlay wrapper. Error toasts without a
// duration never auto-dismiss, so the card stays put.
export const LongNoticeOnPhone = () => (
  <MuxPreviewShell>
    <div className="bg-background text-foreground w-[375px] p-2">
      <ChatInputToast
        wrap={false}
        onDismiss={() => undefined}
        toast={{
          id: "plugin-hook-notice",
          type: "error",
          title: "guard",
          message: "検査に失敗しました。".repeat(200),
        }}
      />
    </div>
  </MuxPreviewShell>
);
