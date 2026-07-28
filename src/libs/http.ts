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
export async function get(url: string, init: RequestInit = {}) {
  const res = await fetchRetry(url, { referrerPolicy: 'origin-when-cross-origin', ...init });
  return res.json();
}

export async function getB(url: string) {
  const res = await fetchRetry(url, { referrerPolicy: 'origin-when-cross-origin' });
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
  // const response = await axios.post((config ? config.api : this.config.api) + url, data)
  return response.json(); // parses JSON response into native JavaScript objects
}
