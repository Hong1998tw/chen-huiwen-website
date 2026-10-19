export function redactBrowserDiagnosticText(value, secretValues = []) {
  let text = String(value || '');
  for (const secret of secretValues) {
    if (typeof secret === 'string' && secret) text = text.split(secret).join('[redacted]');
  }
  text = text.replace(/https?:\/\/[^\s"'<>]+/g, (raw) => {
    const punctuation = raw.match(/[),.;]+$/)?.[0] || '';
    let candidate = raw.slice(0, raw.length - punctuation.length);
    const sourceLocation = candidate.match(/:(\d+):(\d+)$/);
    let lineSuffix = '';
    if (sourceLocation) {
      lineSuffix = `:${sourceLocation[1]}:${sourceLocation[2]}`;
      candidate = candidate.slice(0, -sourceLocation[0].length);
    }
    try {
      const url = new URL(candidate);
      if (!['http:', 'https:'].includes(url.protocol)) return `[url]${lineSuffix}${punctuation}`;
      return `${url.origin}${url.pathname}${lineSuffix}${punctuation}`;
    } catch {
      return `[url]${lineSuffix}${punctuation}`;
    }
  });
  return text
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\b(cookie|set-cookie|authorization|proxy-authorization|cf-access-jwt-assertion)\s*[:=]\s*[^\r\n]*/gi,
      (_match, name) => `${name}=[redacted]`)
    .replace(/\b(session|nonce|token|assertion)\s*[:=]\s*[^,\s;]+/gi,
      (_match, name) => `${name}=[redacted]`);
}

export function safeBrowserDiagnosticText(value, secretValues = []) {
  return redactBrowserDiagnosticText(value, secretValues).slice(0, 4000);
}
