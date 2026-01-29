import assert from 'node:assert/strict';
import test from 'node:test';

const SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1:54321';
const ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const FUNCTIONS_BASE = `${SUPABASE_URL}/functions/v1`;
const DEFAULT_PASSWORD = 'TestPassword123!';

const APP_A_ID = '11111111-1111-1111-1111-111111111111';
const APP_B_ID = '22222222-2222-2222-2222-222222222222';

if (!ANON_KEY || !SERVICE_ROLE_KEY) {
  throw new Error('SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are required to run userland tests.');
}

async function requestJson(url, { method = 'GET', token, apiKey, body, expectStatus } = {}) {
  const headers = {
    'Content-Type': 'application/json',
  };
  if (apiKey) headers.apikey = apiKey;
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  const expected = expectStatus ?? (res.ok ? res.status : null);
  if (expected && res.status !== expected) {
    throw new Error(`Request failed (${res.status}) for ${url}: ${JSON.stringify(data)}`);
  }
  if (!res.ok && !expected) {
    throw new Error(`Request failed (${res.status}) for ${url}: ${JSON.stringify(data)}`);
  }
  return data;
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForRest() {
  const url = `${SUPABASE_URL}/rest/v1/app_users?select=app_id&limit=1`;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const res = await fetch(url, {
      headers: {
        apikey: SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      },
    });
    if (res.status !== 503) {
      return;
    }
    await delay(1000);
  }
  throw new Error('PostgREST did not become ready in time.');
}

function uniqueEmail(prefix) {
  const id = crypto.randomUUID().split('-')[0];
  return `${prefix}-${id}@example.com`;
}

async function signUpUser(prefix) {
  const email = uniqueEmail(prefix);
  const payload = { email, password: DEFAULT_PASSWORD };
  const data = await requestJson(`${SUPABASE_URL}/auth/v1/signup`, {
    method: 'POST',
    apiKey: ANON_KEY,
    body: payload,
  });
  const token = data.access_token || data.session?.access_token;
  const userId = data.user?.id || data.session?.user?.id;
  assert.ok(token, 'signup should return access token');
  assert.ok(userId, 'signup should return user id');
  return { email, userId, token };
}

async function createAppSchema(appId) {
  await requestJson(`${SUPABASE_URL}/rest/v1/rpc/create_app_schema`, {
    method: 'POST',
    apiKey: SERVICE_ROLE_KEY,
    token: SERVICE_ROLE_KEY,
    body: { app_id: appId, create_items: true },
  });
}

async function addMember(appId, userId) {
  await requestJson(`${SUPABASE_URL}/rest/v1/app_users`, {
    method: 'POST',
    apiKey: SERVICE_ROLE_KEY,
    token: SERVICE_ROLE_KEY,
    body: { app_id: appId, user_id: userId, role: 'member' },
  });
}

test('userland apps are partitioned by schema and membership', async () => {
  await waitForRest();
  await createAppSchema(APP_A_ID);
  await createAppSchema(APP_B_ID);

  const sharedUser = await signUpUser('userland-shared');
  const onlyAUser = await signUpUser('userland-aonly');

  await addMember(APP_A_ID, sharedUser.userId);
  await addMember(APP_B_ID, sharedUser.userId);
  await addMember(APP_A_ID, onlyAUser.userId);

  const suffix = crypto.randomUUID().split('-')[0];
  const labelA = `from_a_${suffix}`;
  const labelB = `from_b_${suffix}`;

  const insertA = await requestJson(`${FUNCTIONS_BASE}/app_${APP_A_ID}__insertItem`, {
    method: 'POST',
    apiKey: ANON_KEY,
    token: sharedUser.token,
    body: { label: labelA },
  });
  assert.equal(insertA.item.label, labelA);

  const insertB = await requestJson(`${FUNCTIONS_BASE}/app_${APP_B_ID}__insertItem`, {
    method: 'POST',
    apiKey: ANON_KEY,
    token: sharedUser.token,
    body: { label: labelB },
  });
  assert.equal(insertB.item.label, labelB);

  const listA = await requestJson(`${FUNCTIONS_BASE}/app_${APP_A_ID}__listItems`, {
    method: 'POST',
    apiKey: ANON_KEY,
    token: sharedUser.token,
  });
  const labelsA = (listA.items || []).map((item) => item.label);
  assert.ok(labelsA.includes(labelA));
  assert.ok(!labelsA.includes(labelB));

  const listB = await requestJson(`${FUNCTIONS_BASE}/app_${APP_B_ID}__listItems`, {
    method: 'POST',
    apiKey: ANON_KEY,
    token: sharedUser.token,
  });
  const labelsB = (listB.items || []).map((item) => item.label);
  assert.ok(labelsB.includes(labelB));
  assert.ok(!labelsB.includes(labelA));

  const forbidden = await requestJson(`${FUNCTIONS_BASE}/app_${APP_B_ID}__listItems`, {
    method: 'POST',
    apiKey: ANON_KEY,
    token: onlyAUser.token,
    expectStatus: 403,
  });
  assert.equal(forbidden.error, 'not_a_member');
});
