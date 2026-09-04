/** Storybook-only noVNC transport: exercise real bootstrap wiring without a live desktop server. */
export default class DesktopRfb extends EventTarget {
  static instances: DesktopRfb[] = [];
  readonly url: string;
  readonly preview: HTMLDivElement;
  scaleViewport = false;
  resizeSession = false;
  viewOnly = false;
  disconnected = false;

  constructor(container: HTMLElement, url: string) {
    super();
    this.url = url;
    this.preview = document.createElement("div");
    this.preview.setAttribute("role", "img");
    this.preview.setAttribute("aria-label", "Desktop session preview");
    this.preview.className =
      "bg-surface-primary text-muted-foreground flex h-full items-center justify-center text-sm";
    this.preview.textContent = "Desktop session preview";
    container.append(this.preview);
    DesktopRfb.instances.push(this);
    queueMicrotask(() => {
      if (!this.disconnected) {
        this.dispatchEvent(new Event("connect"));
      }
    });
  }

  disconnect() {
    this.disconnected = true;
    this.preview.remove();
  }
}
