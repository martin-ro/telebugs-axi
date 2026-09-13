import { AxiError } from 'axi-sdk-js';

export function usage(message, suggestions = []) {
  throw new AxiError(message, 'VALIDATION_ERROR', suggestions);
}

export function positive(value, name, max = Number.MAX_SAFE_INTEGER) {
  if (!/^[1-9]\d*$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) > max) {
    usage(`${name} must be an integer from 1 to ${max}.`);
  }
  return Number(value);
}

export function configuration(env = process.env) {
  let url;
  try { url = new URL(env.TELEBUGS_URL); } catch { /* Report no private URL. */ }
  if (!url || url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      !(url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
    throw new AxiError('Set TELEBUGS_URL to your HTTPS instance origin, without a path or credentials.', 'CONFIG');
  }
  const token = env.TELEBUGS_API_KEY;
  if (!token || /\s/.test(token)) {
    throw new AxiError('Set TELEBUGS_API_KEY from Account Settings > API access. Do not use a project DSN.', 'AUTH');
  }
  return { url, token };
}

export async function request(path, { method = 'GET', query = {}, body, env = process.env, fetchImpl = fetch, timeout = 15000 } = {}) {
  const { url, token } = configuration(env);
  url.pathname = `/api/telebugs/v1/${path}`;
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  const help = method === 'GET'
    ? ['Check the instance address and access, then run the same read command.']
    : ['The write outcome may be unknown. Inspect the group before retrying the command.'];
  try {
    const response = await fetchImpl(url, {
      method, redirect: 'manual', signal: AbortSignal.timeout(timeout),
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json, application/problem+json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) {
      await response.body?.cancel();
      const hints = {
        401: 'Replace TELEBUGS_API_KEY with a valid account API key.',
        403: 'Ask an administrator to check your project access.',
        404: 'Check the project, group, and report IDs and your access.',
        422: 'Telebugs rejected the arguments. Check IDs, search syntax, and date filters.',
        429: 'Wait before retrying. No automatic retry was made.',
      };
      throw new AxiError(`Telebugs returned HTTP ${response.status}.`, `HTTP_${response.status}`,
        [hints[response.status] ?? (response.status < 400 ? 'Redirect refused. Set TELEBUGS_URL to the final instance origin.' : help[0])]);
    }
    if (response.status === 204) return null;
    const data = await response.json();
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('invalid response');
    return data;
  } catch (error) {
    if (error instanceof AxiError) throw error;
    throw new AxiError('Telebugs request failed or returned invalid JSON. No automatic retry was made.', 'TRANSPORT', help);
  }
}

// Redaction is a safety net, not a substitute for scrubbing reports at ingestion.
export function redact(value, token = process.env.TELEBUGS_API_KEY) {
  if (typeof value === 'string') {
    let text = token ? value.replaceAll(token, '[REDACTED]') : value;
    return text.replace(/tlbgs_[A-Za-z0-9_-]+/g, '[REDACTED]');
  }
  if (Array.isArray(value)) return value.map(item => redact(item, token));
  if (value && typeof value === 'object') {
    const sensitive = /token|secret|password|authorization|cookie|api[_-]?key|dsn/i;
    if (sensitive.test(String(value.key ?? value.name ?? ''))) {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [redact(key, token), ['value', 'data'].includes(key) ? '[REDACTED]' : redact(item, token)]));
    }
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [redact(key, token), sensitive.test(key) ? '[REDACTED]' : redact(item, token)]));
  }
  return value;
}

export function preview(value, full = false, max = 1000) {
  let truncated = false;
  function visit(item) {
    if (!full && typeof item === 'string' && item.length > max) {
      truncated = true;
      const end = /[\uD800-\uDBFF]/.test(item[max - 1]) && /[\uDC00-\uDFFF]/.test(item[max]) ? max - 1 : max;
      return `${item.slice(0, end)}... (truncated, ${item.length} UTF-16 units total; use --full)`;
    }
    if (Array.isArray(item)) {
      const result = item.slice(0, full ? undefined : 20).map(visit);
      if (!full && item.length > 20) {
        truncated = true;
        result.push({ truncated: `${item.length - 20} more items; ${item.length} total; use --full` });
      }
      return result;
    }
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([key, val]) => [key, visit(val)]));
    return item;
  }
  return { value: visit(value), truncated };
}
