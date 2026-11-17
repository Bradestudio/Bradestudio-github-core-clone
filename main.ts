import { createApp } from './app.ts';

const rawEnvUrl = process.env.MAKEFUN_ENV_URL;
const envUrl = rawEnvUrl ? rawEnvUrl.replace(/\/+$/, '') : '';

if (!envUrl) {
  console.error('error: no environment to register with (MAKEFUN_ENV_URL is not set)');
  process.exit(1);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Wait grows 250ms, 500ms, 1000ms, then stays at the 2s ceiling.
function backoffDelay(attempt: number): number {
  const step = Math.min(attempt, 8);
  return Math.min(250 * 2 ** step, 2000);
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

let server: any = null;

try {
  const app = createApp();

  server = await new Promise((resolve, reject) => {
    let listening: any;
    listening = app.listen(0, () => resolve(listening));
    listening.on('error', reject);
  });

  const address = server.address();
  const port = address.port;
  console.log(`Forge listening on port ${port}`);

  // Tell the trial environment where to reach this forge. Keep trying
  // forever: the environment may not be ready yet when we first call.
  // 200 means accepted, 409 means another entry registered first and we
  // can simply carry on waiting. 400/405 means our request is wrong.
  let attempt = 0;
  for (;;) {
    let response: Response | null = null;
    try {
      response = await fetchWithTimeout(`${envUrl}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
      });
    } catch {
      await sleep(backoffDelay(attempt));
      attempt++;
      continue;
    }

    if (response.status === 200 || response.status === 409) {
      break;
    }
    if (response.status === 400 || response.status === 405) {
      throw new Error(`register rejected by environment with status ${response.status}`);
    }
    await sleep(backoffDelay(attempt));
    attempt++;
  }
  console.log(`Registered with environment on port ${port}`);

  // Wait until the environment says the trial suite is finished. It
  // answers each poll at once, so a false answer just means "not yet".
  let pollAttempt = 0;
  for (;;) {
    let response: Response | null = null;
    try {
      response = await fetchWithTimeout(`${envUrl}/done`, { method: 'GET' });
    } catch {
      await sleep(backoffDelay(pollAttempt));
      pollAttempt++;
      continue;
    }

    let finished = false;
    try {
      const body: any = await response.json();
      finished = body !== null && typeof body === 'object' && body.done === true;
    } catch {
      finished = false;
    }
    if (finished) {
      break;
    }
    await sleep(backoffDelay(pollAttempt));
    pollAttempt++;
  }
  console.log('Environment reported done, shutting down');

  await new Promise<void>((resolve) => server.close(() => resolve()));
  server = null;
  process.exit(0);
} catch (err) {
  console.error(err);
  if (server !== null) {
    try {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    } catch {
      // Already shutting down with an error; nothing more to do.
    }
  }
  process.exit(1);
}
