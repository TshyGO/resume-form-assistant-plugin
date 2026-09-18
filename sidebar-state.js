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

  function equal(left, right) {
    const normalizedLeft = normalize(left);
    const normalizedRight = normalize(right);
    return normalizedLeft.collapsed === normalizedRight.collapsed
      && normalizedLeft.left === normalizedRight.left
      && normalizedLeft.top === normalizedRight.top;
  }

  function constrainAxis(value, size, viewport, margin) {
    const maxPosition = Math.max(0, viewport - size);
    const minPosition = Math.min(margin, maxPosition);
    const maxInsetPosition = Math.max(minPosition, maxPosition - margin);
    return Math.min(Math.max(value, minPosition), maxInsetPosition);
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
    const safeMargin = Math.max(0, isFiniteNumber(margin) ? margin : VIEWPORT_MARGIN);

    return {
      collapsed: normalized.collapsed,
      left: constrainAxis(normalized.left, width, viewportWidth, safeMargin),
      top: constrainAxis(normalized.top, height, viewportHeight, safeMargin)
    };
  }

  async function read(storage) {
    const current = await storage.get(STORAGE_KEY);
    return normalize(current?.[STORAGE_KEY]);
  }

  async function readOrDefault(storage) {
    try {
      return await read(storage);
    } catch (_error) {
      return normalize(null);
    }
  }

  async function write(storage, uiState) {
    const normalized = normalize(uiState);
    await storage.set({ [STORAGE_KEY]: normalized });
    return normalized;
  }

  return { STORAGE_KEY, VIEWPORT_MARGIN, normalize, equal, constrain, read, readOrDefault, write };
});
