import React from "react";
import type { HexColorPicker as HexColorPickerComponent } from "react-colorful";
import { LazyFeature } from "@/browser/components/LazyFeature/LazyFeature";

// react-colorful renders only inside the section and project color popovers, so it stays off
// the first load. #6982: about 1 KB of main.js growth crossed a Lighthouse simulated round trip
// (+40 ms desktop LCP), and this cut moves main.js back under it.
const HexColorPicker = React.lazy(() =>
  import("react-colorful").then((module) => ({ default: module.HexColorPicker }))
);

export function LazyHexColorPicker(props: React.ComponentProps<typeof HexColorPickerComponent>) {
  return (
    // The fallback reuses the picker's root class, so the popover keeps its size while loading.
    <LazyFeature name="Color picker" fallback={<div className="react-colorful" />}>
      <HexColorPicker {...props} />
    </LazyFeature>
  );
}
