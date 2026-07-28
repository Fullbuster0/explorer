import fetch from 'cross-fetch';

/**
 * Shared fetch with a hard timeout (AbortController) + one retry.
 *
 * Why: LCD/REST endpoints occasionally hang (TCP connect OK, no response).
 * Without a timeout the promise never settles → store init blocks → the page
 * looks frozen and users have to hard-refresh. A bounded timeout + single
 * retry makes those transient stalls self-heal.
 */
const DEFAULT_TIMEOUT = 12000;

async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = DEFAULT_TIMEOUT) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchRetry(
  url: string,
  init: RequestInit = {},
  timeoutMs = DEFAULT_TIMEOUT,
  retries = 1
) {
  let lastErr: any;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fetchWithTimeout(url, init, timeoutMs);
    } catch (e) {
      lastErr = e;
      // only retry on network/abort errors, not on HTTP status (handled by caller)
      if (attempt < retries) continue;
    }
  }
  throw lastErr;
}

export async function fetchData<T>(url: string, adapter: (source: any) => Promise<T>): Promise<T> {
  const response = await fetchRetry(url);
  if (!response.ok) {
    throw new Error(`HTTP error: ${response.status}, ${response.statusText}`);
  }
  const data = await response.json();
  return adapter(data);
}

// Usage:
/*
const userAdapter = (source: any) => {
  return {
    id: source.id,
    name: source.name,
    email: source.email,
  };
};
try {
  const userData = await fetchData<User>("https://jsonplaceholder.typicode.com/users/1", userAdapter);
  console.log(userData); // output be:
  // {
  //   id: 1,
  //   name: 'Leanne Graham',
  //   email: 'Sincere@april.biz',
  // }
} catch (error) {
  console.error(error.message);
}
// */
/**
 * Parse JSON only after validating HTTP status + content.
 * Bare res.json() on 4xx/5xx/HTML/empty bodies caused uncaught
 * `SyntaxError: Unexpected end of JSON input` / `Unexpected token '<'`
 * across gov, accounts, coingecko-adjacent paths (audit HTTP-01).
 */
async function readJsonOrThrow(res: Response) {
  if (!res.ok) {
    // Drain body so the connection can be reused; ignore parse failures.
    try {
      await res.text();
    } catch {
      /* ignore */
    }
    throw new Error(`HTTP error: ${res.status}, ${res.statusText}`);
  }
  const text = await res.text();
  if (!text || !text.trim()) {
    throw new Error(`HTTP error: empty body (${res.status})`);
  }
  try {
    return JSON.parse(text);
  } catch (e: any) {
    const snip = text.slice(0, 80).replace(/\s+/g, ' ');
    throw new Error(`HTTP error: invalid JSON (${res.status}): ${snip}`);
  }
}

export async function get(url: string, init: RequestInit = {}) {
  const res = await fetchRetry(url, { referrerPolicy: 'origin-when-cross-origin', ...init });
  return readJsonOrThrow(res);
}

export async function getB(url: string) {
  const res = await fetchRetry(url, { referrerPolicy: 'origin-when-cross-origin' });
  if (!res.ok) {
    throw new Error(`HTTP error: ${res.status}, ${res.statusText}`);
  }
  return res.arrayBuffer();
}

export async function post(url: string, data: any) {
  const response = await fetchRetry(url, {
    method: 'POST', // *GET, POST, PUT, DELETE
    // mode: 'cors', // no-cors, *cors, same-origin
    // credentials: 'same-origin', // redirect: 'follow', *manual, follow, error
    referrerPolicy: 'origin-when-cross-origin', // no-referrer, *no-referrer-when-downgrade, origin, origin-when-cross-origin, same-origin, strict-origin, strict-origin-when-cross-origin, unsafe-url
    headers: {
      'Content-Type': 'application/json',
      Accept: '*/*',
      // 'Accept-Encoding': 'gzip, deflate, br',
    },
    body: JSON.stringify(data), // body data type must match "Content-Type"
  });
  return readJsonOrThrow(response);
}
