export function supportsScrollOptions() {
  if (typeof document === "undefined") return false;
  return "scrollBehavior" in document.documentElement.style;
}

export function safeScrollTo(container, top, left, behavior = "auto") {
  if (!container || !(container instanceof HTMLElement)) return;
  if (supportsScrollOptions()) {
    try {
      const options = { behavior };
      if (typeof top === "number") options.top = top;
      if (typeof left === "number") options.left = left;
      container.scrollTo(options);
      return;
    } catch (_) {
      // Fallback, falls das Options-Objekt trotzdem fehlschlägt
    }
  }
  if (typeof top === "number") container.scrollTop = top;
  if (typeof left === "number") container.scrollLeft = left;
}

export function safeScrollIntoView(node, options = {}) {
  if (!node || !(node instanceof HTMLElement)) return;
  if (supportsScrollOptions()) {
    try {
      node.scrollIntoView(options);
      return;
    } catch (_) {
      // Fallback, falls das Options-Objekt trotzdem fehlschlägt
    }
  }
  node.scrollIntoView();
}
