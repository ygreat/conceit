import { initAssets } from "./board/assets";
import { boot } from "./files/boot";
import { applyTheme, getSettings } from "./settings";

// Before first paint, so there is no flash of the wrong theme.
applyTheme(getSettings().theme);

// Benign browser warning when many cards are measured in one frame (e.g. adding
// 1,000 objects). WebKit reports it as an uncaught error; it's not one.
window.addEventListener(
  "error",
  (e) => {
    if (e.message?.includes("ResizeObserver loop")) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  },
  true, // capture, so this runs before the dev server's error overlay
);

// Resolve the asset store path first so local media renders on the first pass.
initAssets().finally(boot);
