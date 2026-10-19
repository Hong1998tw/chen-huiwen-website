/** Check an element's ancestor visibility and rendered-box intersection with its viewport. */
export function isVisibleInViewport(element) {
  if (!element || element.isConnected === false) return false;
  const view = element.ownerDocument?.defaultView;
  if (!view || typeof view.getComputedStyle !== 'function') return false;

  const rects = Array.from(element.getClientRects?.() || []);
  if (!rects.length) return false;

  for (let current = element; current; current = current.parentElement) {
    if (current.hasAttribute?.('hidden')) return false;
    if (current.localName === 'details' && current !== element && !current.open) {
      const summary = Array.from(current.children || []).find((child) => child.localName === 'summary');
      if (!summary?.contains(element)) return false;
    }

    const style = view.getComputedStyle(current);
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' ||
        style.contentVisibility === 'hidden' || Number(style.opacity) <= 0) return false;
  }

  return rects.some((rect) => rect.width > 0 && rect.height > 0
    && rect.right > 0 && rect.left < view.innerWidth
    && rect.bottom > 0 && rect.top < view.innerHeight);
}
