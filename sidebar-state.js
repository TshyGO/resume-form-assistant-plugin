(function (root, factory) {
  const api = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.ResumeProSidebarState = api;
  }
})(typeof self !== "undefined" ? self : globalThis, function () {
  const STORAGE_KEY = "resumeProSidebarUiState";
  const VIEWPORT_MARGIN = 12;

  function isFiniteNumber(value) {
    return typeof value === "number" && Number.isFinite(value);
  }

  function normalize(raw) {
    const hasPosition = isFiniteNumber(raw?.left) && isFiniteNumber(raw?.top);
    return {
      collapsed: raw?.collapsed === true,
      left: hasPosition ? raw.left : null,
      top: hasPosition ? raw.top : null
    };
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), Math.max(min, max));
  }

  function constrain(position, size, viewport, margin = VIEWPORT_MARGIN) {
    const normalized = normalize(position);
    if (normalized.left === null || normalized.top === null) {
      return normalized;
    }

    const width = Math.max(0, isFiniteNumber(size?.width) ? size.width : 0);
    const height = Math.max(0, isFiniteNumber(size?.height) ? size.height : 0);
    const viewportWidth = Math.max(0, isFiniteNumber(viewport?.width) ? viewport.width : 0);
    const viewportHeight = Math.max(0, isFiniteNumber(viewport?.height) ? viewport.height : 0);

    return {
      collapsed: normalized.collapsed,
      left: clamp(normalized.left, margin, viewportWidth - width - margin),
      top: clamp(normalized.top, margin, viewportHeight - height - margin)
    };
  }

  async function read(storage) {
    const current = await storage.get(STORAGE_KEY);
    return normalize(current[STORAGE_KEY]);
  }

  async function write(storage, uiState) {
    const normalized = normalize(uiState);
    await storage.set({ [STORAGE_KEY]: normalized });
    return normalized;
  }

  return { STORAGE_KEY, VIEWPORT_MARGIN, normalize, constrain, read, write };
});
