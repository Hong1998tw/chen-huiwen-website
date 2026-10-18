/** Shared WCAG inline-link exception predicate used by the browser runner and pure tests. */
const inlineContainers = 'p,li,blockquote,dd,figcaption,h1,h2,h3,h4,h5,h6';
const interactiveOrNonText = 'a,button,summary,input,select,textarea,[role="button"],[role="link"],[role="checkbox"],[role="switch"],[role="tab"],[role="menuitem"],script,style,noscript,template';
const excludedRegions = 'nav,.footer,.topline,.news-source-links,.news-article-nav,.news-pagination';

export function isInlineTextException(element) {
  const document = element.ownerDocument;
  const getStyle = node => document.defaultView.getComputedStyle(node);
  if (element.localName !== 'a' || getStyle(element).display !== 'inline') return false;
  if (element.matches('.button,[role="button"]') || element.closest(excludedRegions)) return false;
  const context = element.closest(inlineContainers);
  if (!context || context.matches(interactiveOrNonText)) return false;
  const targetRects = Array.from(element.getClientRects()).filter(rect => rect.width > 0 && rect.height > 0);
  if (!targetRects.length) return false;

  const hasVisibleNonTargetText = node => {
    if (node.nodeType === 3) {
      if (!String(node.nodeValue || '').trim()) return false;
      const parent = node.parentElement;
      if (!parent || parent.closest(interactiveOrNonText)) return false;
      for (let current = parent; current; current = current.parentElement) {
        if (current.hasAttribute('hidden')) return false;
        const style = getStyle(current);
        if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' ||
            style.contentVisibility === 'hidden' || Number(style.opacity) === 0 ||
            /\bopacity\(\s*(?:0(?:\.0*)?|\.0+)%?\s*\)/i.test(style.filter || '') ||
            (style.clip && style.clip !== 'auto' && style.clip !== 'none') ||
            (style.clipPath && style.clipPath !== 'none')) return false;
        if (current === context) break;
      }
      const range = document.createRange();
      range.selectNodeContents(node);
      const textRects = Array.from(range.getClientRects()).filter(rect => rect.width > 0 && rect.height > 0);
      return textRects.some(textRect => targetRects.some(targetRect => {
        const sharesLine = textRect.top < targetRect.bottom && targetRect.top < textRect.bottom;
        const horizontalGap = Math.max(textRect.left - targetRect.right, targetRect.left - textRect.right, 0);
        return sharesLine && horizontalGap <= Math.max(24, targetRect.height * 2);
      }));
    }
    if (node.nodeType !== 1 || (node !== context && node.matches(interactiveOrNonText))) return false;
    return Array.from(node.childNodes).some(hasVisibleNonTargetText);
  };

  return Array.from(context.childNodes).some(hasVisibleNonTargetText);
}

if (typeof window !== 'undefined') {
  Object.defineProperty(window, '__g04TargetSize', {
    configurable: true,
    value: Object.freeze({ isInlineTextException })
  });
}
