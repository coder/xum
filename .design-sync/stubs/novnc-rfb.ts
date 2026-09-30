// Stub for @novnc/novnc/lib/rfb used only by the design-sync bundle/previews.
// The real VNC client uses top-level await (incompatible with the IIFE design
// bundle) and needs a live server, neither of which exists in a static design
// render. DesktopPanel dynamically imports this; the stub lets it mount its UI
// shell (toolbar, status) without a stream. Mapped in tsconfig.ds.json.
export default class RFB extends EventTarget {
  scaleViewport = true;
  clipViewport = false;
  background = "";
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(..._args: unknown[]) {
    super();
  }
  disconnect(): void {}
  sendKey(): void {}
  sendCtrlAltDel(): void {}
  focus(): void {}
  blur(): void {}
  machineShutdown(): void {}
  clipboardPasteFrom(): void {}
}
