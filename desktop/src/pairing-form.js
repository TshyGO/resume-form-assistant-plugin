export function createPairingController() {
  let generation = 0;
  let chromeDirty = false;
  let edgeDirty = false;

  return {
    beginRefresh() {
      generation += 1;
      return generation;
    },
    markChromeDirty() {
      chromeDirty = true;
    },
    markEdgeDirty() {
      edgeDirty = true;
    },
    applyStatus(token, pairing) {
      if (token !== generation) {
        return { applied: false, reason: "stale" };
      }
      const nextChrome = pairing?.chromeExtensionId ?? "";
      const nextEdge = pairing?.edgeExtensionId ?? "";
      return {
        applied: true,
        chrome: chromeDirty ? undefined : nextChrome,
        edge: edgeDirty ? undefined : nextEdge,
      };
    },
    onSaveSuccess(saved) {
      chromeDirty = false;
      edgeDirty = false;
      generation += 1;
      return {
        chrome: saved?.chromeExtensionId ?? "",
        edge: saved?.edgeExtensionId ?? "",
      };
    },
    onSaveFailure() {
      return {
        keepInput: true,
        chromeDirty,
        edgeDirty,
      };
    },
    snapshot() {
      return { generation, chromeDirty, edgeDirty };
    },
  };
}
