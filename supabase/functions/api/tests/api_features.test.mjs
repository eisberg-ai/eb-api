import assert from 'node:assert/strict';
import test from 'node:test';

const SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1:54321';
const ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const FUNCTIONS_URL = `${SUPABASE_URL}/functions/v1/api`;
const DEFAULT_PASSWORD = 'TestPassword123!';

if (!ANON_KEY || !SERVICE_ROLE_KEY) {
  throw new Error('SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are required to run API tests.');
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

test('non-admin invite sign-up sets join method', async () => {
  const inviter = await signUpUser('inviter');
  const invite = await requestJson(`${FUNCTIONS_URL}/invites`, {
    method: 'POST',
    apiKey: ANON_KEY,
    token: inviter.token,
  });
  assert.ok(invite.code, 'invite code should be returned');

  const invitee = await signUpUser('invitee');
  await requestJson(`${FUNCTIONS_URL}/auth/invite`, {
    method: 'POST',
    apiKey: ANON_KEY,
    token: invitee.token,
    body: { code: invite.code },
  });

  const profile = await requestJson(`${FUNCTIONS_URL}/users/profile`, {
    apiKey: ANON_KEY,
    token: invitee.token,
  });
  assert.equal(profile.joinMethod, 'invite');
  assert.equal(profile.joinCode, invite.code);
});

test('promo code redemption marks join method', async () => {
  const promo = await requestJson(`${FUNCTIONS_URL}/admin/promo-codes`, {
    method: 'POST',
    apiKey: SERVICE_ROLE_KEY,
    token: SERVICE_ROLE_KEY,
    body: { amount: 5 },
  });
  assert.ok(promo.code, 'promo code should be returned');

  const user = await signUpUser('promo');
  await requestJson(`${FUNCTIONS_URL}/billing/promo`, {
    method: 'POST',
    apiKey: ANON_KEY,
    token: user.token,
    body: { code: promo.code },
  });

  const profile = await requestJson(`${FUNCTIONS_URL}/users/profile`, {
    apiKey: ANON_KEY,
    token: user.token,
  });
  assert.equal(profile.joinMethod, 'promo');
  assert.equal(profile.joinCode, promo.code);
});

test('admin approval and denial are enforced by waitlist gate', async () => {
  const approvedUser = await signUpUser('approved');
  await requestJson(`${FUNCTIONS_URL}/admin/users/${approvedUser.userId}/approval`, {
    method: 'POST',
    apiKey: SERVICE_ROLE_KEY,
    token: SERVICE_ROLE_KEY,
    body: { status: 'approved' },
  });

  const approvedGate = await requestJson(`${FUNCTIONS_URL}/auth/waitlist`, {
    apiKey: ANON_KEY,
    token: approvedUser.token,
  });
  assert.equal(approvedGate.allowed, true);
  assert.equal(approvedGate.accessStatus, 'approved');

  const deniedUser = await signUpUser('denied');
  await requestJson(`${FUNCTIONS_URL}/admin/users/${deniedUser.userId}/approval`, {
    method: 'POST',
    apiKey: SERVICE_ROLE_KEY,
    token: SERVICE_ROLE_KEY,
    body: { status: 'denied' },
  });

  const deniedGate = await requestJson(`${FUNCTIONS_URL}/auth/waitlist`, {
    apiKey: ANON_KEY,
    token: deniedUser.token,
    expectStatus: 403,
  });
  assert.equal(deniedGate.allowed, false);
  assert.equal(deniedGate.accessStatus, 'denied');
});
