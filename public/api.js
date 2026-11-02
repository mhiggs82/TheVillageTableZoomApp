// Calls our server. Every request carries Zoom's signed app context so the server can tell
// who is asking and in which meeting without trusting the browser.
export async function api(sdk, method, path, body, role) {
  const { context } = await sdk.getAppContext();
  const headers = { 'x-zoom-app-context': context };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (role) headers['x-claimed-role'] = role; // only honoured if the server is told to (first-test fallback)
  const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let data = {};
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) {
    const err = new Error(data.error || 'Something went wrong. Try again.');
    err.status = res.status;
    throw err;
  }
  return data;
}
