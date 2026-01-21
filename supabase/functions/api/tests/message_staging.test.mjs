import assert from 'node:assert/strict';
import test from 'node:test';

const SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1:54321';
const ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const FUNCTIONS_URL = `${SUPABASE_URL}/functions/v1/api`;
const DEFAULT_PASSWORD = 'TestPassword123!';

if (!ANON_KEY || !SERVICE_ROLE_KEY) {
  throw new Error('SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are required');
}

async function requestJson(url, { method = 'GET', token, apiKey, body, expectStatus } = {}) {
  const headers = { 'Content-Type': 'application/json' };
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

async function approveUser(userId) {
  await requestJson(`${FUNCTIONS_URL}/admin/users/${userId}/approval`, {
    method: 'POST',
    apiKey: SERVICE_ROLE_KEY,
    token: SERVICE_ROLE_KEY,
    body: { status: 'approved' },
  });
}

async function giveCredits(userId, amount) {
  await requestJson(`${FUNCTIONS_URL}/admin/promo-codes`, {
    method: 'POST',
    apiKey: SERVICE_ROLE_KEY,
    token: SERVICE_ROLE_KEY,
    body: { amount, code: `test-${userId.slice(0, 8)}` },
  });
  const promo = await requestJson(`${FUNCTIONS_URL}/billing/promo`, {
    method: 'POST',
    apiKey: ANON_KEY,
    token: userId,
    body: { code: `test-${userId.slice(0, 8)}` },
  });
  return promo;
}

async function createProject(token, projectId) {
  return await requestJson(`${FUNCTIONS_URL}/projects`, {
    method: 'POST',
    apiKey: ANON_KEY,
    token,
    body: { id: projectId, name: 'Test Project', model: 'claude-sonnet-4-5' },
  });
}

async function sendMessage(token, projectId, message, attachments = null) {
  return await requestJson(`${FUNCTIONS_URL}/chat`, {
    method: 'POST',
    apiKey: ANON_KEY,
    token,
    body: {
      project_id: projectId,
      message,
      model: 'claude-sonnet-4-5',
      attachments,
    },
  });
}

async function getStagedBuilds(token, projectId) {
  return await requestJson(`${FUNCTIONS_URL}/projects/${projectId}/staged-builds`, {
    apiKey: ANON_KEY,
    token,
  });
}

async function deleteStagedBuild(token, buildId) {
  return await requestJson(`${FUNCTIONS_URL}/builds/${buildId}/staged`, {
    method: 'DELETE',
    apiKey: ANON_KEY,
    token,
  });
}

async function updateBuildStatus(buildId, status) {
  return await requestJson(`${FUNCTIONS_URL}/builds/${buildId}`, {
    method: 'PATCH',
    apiKey: SERVICE_ROLE_KEY,
    token: SERVICE_ROLE_KEY,
    body: { status },
  });
}

test('first message creates non-staged build', async () => {
  const user = await signUpUser('staging-first');
  await approveUser(user.userId);
  const projectId = `project-staging-first-${crypto.randomUUID().slice(0, 8)}`;
  await createProject(user.token, projectId);
  const result = await sendMessage(user.token, projectId, 'Build a todo app');
  assert.equal(result.ok, true);
  assert.equal(result.staged, undefined, 'first message should not be staged');
  assert.ok(result.build?.id, 'should return build id');
});

test('follow-up message creates staged build when build is active', async () => {
  const user = await signUpUser('staging-followup');
  await approveUser(user.userId);
  const projectId = `project-staging-followup-${crypto.randomUUID().slice(0, 8)}`;
  await createProject(user.token, projectId);
  // first message (non-staged)
  const first = await sendMessage(user.token, projectId, 'Build a todo app');
  assert.equal(first.staged, undefined);
  const firstBuildId = first.build.id;
  // second message while first is pending (should be staged)
  const second = await sendMessage(user.token, projectId, 'Add dark mode');
  assert.equal(second.ok, true);
  assert.equal(second.staged, true, 'follow-up should be staged');
  assert.equal(second.build.depends_on_build_id, firstBuildId, 'should depend on first build');
  assert.equal(second.build.status, 'pending');
});

test('can queue up to 3 staged builds', async () => {
  const user = await signUpUser('staging-max');
  await approveUser(user.userId);
  const projectId = `project-staging-max-${crypto.randomUUID().slice(0, 8)}`;
  await createProject(user.token, projectId);
  // first message (non-staged)
  await sendMessage(user.token, projectId, 'Build a todo app');
  // queue 3 follow-ups
  const second = await sendMessage(user.token, projectId, 'Add dark mode');
  assert.equal(second.staged, true);
  const third = await sendMessage(user.token, projectId, 'Add auth');
  assert.equal(third.staged, true);
  const fourth = await sendMessage(user.token, projectId, 'Add search');
  assert.equal(fourth.staged, true);
  // fourth follow-up should fail
  try {
    await sendMessage(user.token, projectId, 'Add export feature');
    assert.fail('should not allow more than 3 staged builds');
  } catch (err) {
    assert.ok(err.message.includes('409') || err.message.includes('max_staged_builds'));
  }
});

test('staged builds are returned by GET endpoint', async () => {
  const user = await signUpUser('staging-get');
  await approveUser(user.userId);
  const projectId = `project-staging-get-${crypto.randomUUID().slice(0, 8)}`;
  await createProject(user.token, projectId);
  // first message
  await sendMessage(user.token, projectId, 'Build a todo app');
  // add staged builds
  await sendMessage(user.token, projectId, 'Add dark mode');
  await sendMessage(user.token, projectId, 'Add auth');
  const staged = await getStagedBuilds(user.token, projectId);
  assert.equal(staged.staged_builds.length, 2);
  assert.equal(staged.staged_builds[0].content, 'Add dark mode');
  assert.equal(staged.staged_builds[1].content, 'Add auth');
  assert.ok(staged.staged_builds[0].depends_on_build_id);
  assert.ok(staged.staged_builds[1].depends_on_build_id);
});

test('staged build is promoted when dependency succeeds', async () => {
  const user = await signUpUser('staging-promote');
  await approveUser(user.userId);
  const projectId = `project-staging-promote-${crypto.randomUUID().slice(0, 8)}`;
  await createProject(user.token, projectId);
  // first message
  const first = await sendMessage(user.token, projectId, 'Build a todo app');
  const firstBuildId = first.build.id;
  // add staged build
  const second = await sendMessage(user.token, projectId, 'Add dark mode');
  assert.equal(second.staged, true);
  const secondBuildId = second.build.id;
  // verify staged build exists
  let staged = await getStagedBuilds(user.token, projectId);
  assert.equal(staged.staged_builds.length, 1);
  // mark first build as succeeded
  await updateBuildStatus(firstBuildId, 'succeeded');
  // wait a bit for promotion logic
  await new Promise(resolve => setTimeout(resolve, 100));
  // verify staged build was promoted (should be empty now)
  staged = await getStagedBuilds(user.token, projectId);
  assert.equal(staged.staged_builds.length, 0, 'staged build should be promoted');
});

test('deleting staged build repairs dependency chain', async () => {
  const user = await signUpUser('staging-delete');
  await approveUser(user.userId);
  const projectId = `project-staging-delete-${crypto.randomUUID().slice(0, 8)}`;
  await createProject(user.token, projectId);
  // first message
  const first = await sendMessage(user.token, projectId, 'Build a todo app');
  const firstBuildId = first.build.id;
  // add 3 staged builds (A -> B -> C)
  const buildA = await sendMessage(user.token, projectId, 'Add dark mode');
  const buildB = await sendMessage(user.token, projectId, 'Add auth');
  const buildC = await sendMessage(user.token, projectId, 'Add search');
  assert.equal(buildA.build.depends_on_build_id, firstBuildId);
  assert.equal(buildB.build.depends_on_build_id, buildA.build.id);
  assert.equal(buildC.build.depends_on_build_id, buildB.build.id);
  // delete buildB
  await deleteStagedBuild(user.token, buildB.build.id);
  // verify chain was repaired: C should now depend on A
  const staged = await getStagedBuilds(user.token, projectId);
  assert.equal(staged.staged_builds.length, 2, 'should have 2 staged builds left');
  const buildCAfterDelete = staged.staged_builds.find(b => b.id === buildC.build.id);
  assert.ok(buildCAfterDelete, 'buildC should still exist');
  assert.equal(buildCAfterDelete.depends_on_build_id, buildA.build.id, 'buildC should now depend on buildA');
});

test('cannot delete non-staged build', async () => {
  const user = await signUpUser('staging-delete-active');
  await approveUser(user.userId);
  const projectId = `project-staging-delete-active-${crypto.randomUUID().slice(0, 8)}`;
  await createProject(user.token, projectId);
  // create a non-staged build
  const first = await sendMessage(user.token, projectId, 'Build a todo app');
  const firstBuildId = first.build.id;
  // try to delete it (should fail)
  try {
    await deleteStagedBuild(user.token, firstBuildId);
    assert.fail('should not allow deleting non-staged build');
  } catch (err) {
    assert.ok(err.message.includes('400') || err.message.includes('can_only_delete_staged'));
  }
});

test('staged builds preserve attachments', async () => {
  const user = await signUpUser('staging-attachments');
  await approveUser(user.userId);
  const projectId = `project-staging-attachments-${crypto.randomUUID().slice(0, 8)}`;
  await createProject(user.token, projectId);
  // first message
  await sendMessage(user.token, projectId, 'Build a todo app');
  // add staged build with attachments
  const attachments = {
    media: [{ id: 'img1', type: 'image', url: 'https://example.com/img.png' }],
    files: [{ id: 'file1', filename: 'spec.pdf', url: 'https://example.com/spec.pdf' }],
  };
  const second = await sendMessage(user.token, projectId, 'Add these features', attachments);
  assert.equal(second.staged, true);
  // verify attachments are preserved
  const staged = await getStagedBuilds(user.token, projectId);
  assert.equal(staged.staged_builds.length, 1);
  assert.ok(staged.staged_builds[0].attachments);
  assert.equal(staged.staged_builds[0].attachments.media.length, 1);
  assert.equal(staged.staged_builds[0].attachments.files.length, 1);
});

test('failed build blocks new messages', async () => {
  const user = await signUpUser('staging-failed');
  await approveUser(user.userId);
  const projectId = `project-staging-failed-${crypto.randomUUID().slice(0, 8)}`;
  await createProject(user.token, projectId);
  // create and fail a build
  const first = await sendMessage(user.token, projectId, 'Build a todo app');
  await updateBuildStatus(first.build.id, 'failed');
  // wait a bit
  await new Promise(resolve => setTimeout(resolve, 100));
  // try to send another message (should fail)
  try {
    await sendMessage(user.token, projectId, 'Add dark mode');
    assert.fail('should not allow new messages after failed build');
  } catch (err) {
    assert.ok(err.message.includes('400') || err.message.includes('build_failed'));
  }
});

test('staged builds are ordered by creation time', async () => {
  const user = await signUpUser('staging-order');
  await approveUser(user.userId);
  const projectId = `project-staging-order-${crypto.randomUUID().slice(0, 8)}`;
  await createProject(user.token, projectId);
  // first message
  await sendMessage(user.token, projectId, 'Build a todo app');
  // add 3 staged builds with delays
  await sendMessage(user.token, projectId, 'First staged');
  await new Promise(resolve => setTimeout(resolve, 50));
  await sendMessage(user.token, projectId, 'Second staged');
  await new Promise(resolve => setTimeout(resolve, 50));
  await sendMessage(user.token, projectId, 'Third staged');
  // verify order
  const staged = await getStagedBuilds(user.token, projectId);
  assert.equal(staged.staged_builds.length, 3);
  assert.equal(staged.staged_builds[0].content, 'First staged');
  assert.equal(staged.staged_builds[1].content, 'Second staged');
  assert.equal(staged.staged_builds[2].content, 'Third staged');
});
