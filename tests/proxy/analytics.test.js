import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const proxyDir = path.resolve(here, '..', '..', 'proxy');
const requireFromProxy = createRequire(path.join(proxyDir, 'package.json'));

const EXT_ID = 'abcdefghijklmnopabcdefghijklmnop';
const EXT_ORIGIN = `chrome-extension://${EXT_ID}`;
const INSTALL_ID = '6f1c1f0e-2b7a-4c55-9d1e-0c2f8a7b9e10';

let app;
let supertest;
let transport;

const post = url => supertest(app).post(url).set('Origin', EXT_ORIGIN);
const sentEvents = () => transport.mock.calls.flatMap(([batch]) => batch);

beforeAll(async () => {
  process.env.EXTENSION_GEMINI_API_KEY = 'test_gemini_key';
  process.env.ALLOWED_EXTENSION_ID = EXT_ID;
  process.env.PORT = '0';
  process.env.MEMORY_IDENTITY_SECRET_V1 = 'memory-identity-test-secret-that-is-long-enough';
  process.env.POSTHOG_API_KEY = 'phc_test';
  process.env.POSTHOG_BLOCKED_SUBS = 'Blocked@Example.com';

  app = requireFromProxy('./index.js');
  supertest = (await import('supertest')).default;
});

beforeEach(() => {
  transport = vi.fn().mockResolvedValue(undefined);
  app.locals.analytics.transport = transport;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('POST /api/events (extension >= 2.2.53)', () => {
  it('forwards an anonymous batch keyed by the install id, keeping only allowlisted data', async () => {
    const res = await post('/api/events').send({
      installId: INSTALL_ID,
      events: [
        {
          event: 'message_sent',
          uuid: '0190f5a2-7c3e-7d4b-8a1f-123456789abc',
          timestamp: new Date().toISOString(),
          properties: {
            channel: 'text',
            history_length: 4,
            page_path: '/workspaces/550e8400-e29b-41d4-a716-446655440000/settings?tab=billing',
            extension_version: '2.2.53',
            text: 'mon mot de passe est hunter2',
            email: 'leak@example.com'
          }
        },
        { event: 'not_a_real_event', properties: { anything: true } }
      ]
    });

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ ok: true, count: 1 });
    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(1));
    const [event] = sentEvents();
    expect(event).toMatchObject({
      event: 'message_sent',
      distinct_id: INSTALL_ID,
      uuid: '0190f5a2-7c3e-7d4b-8a1f-123456789abc'
    });
    expect(event.properties).toMatchObject({
      channel: 'text',
      history_length: 4,
      page_path: '/workspaces/:id/settings',
      extension_version: '2.2.53',
      install_id: INSTALL_ID,
      $lib: 'limova-proxy'
    });
    expect(event.properties).not.toHaveProperty('text');
    expect(event.properties).not.toHaveProperty('email');
    expect(event.properties).not.toHaveProperty('$set');
  });

  it('attributes a signed-in batch to the user and links the install once', async () => {
    const token = app.locals.authTesting.issueSessionToken({ id: 'user-42', email: 'Member@Example.com' });
    const send = () => post('/api/events')
      .set('Authorization', `Bearer ${token}`)
      .send({ installId: INSTALL_ID, events: [{ event: 'sidebar_opened', properties: { authenticated: true } }] });

    expect((await send()).status).toBe(202);
    expect((await send()).status).toBe(202);
    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(2));

    const events = sentEvents();
    const identifies = events.filter(item => item.event === '$identify');
    expect(identifies).toHaveLength(1);
    expect(identifies[0]).toMatchObject({
      distinct_id: 'user-42',
      properties: { $anon_distinct_id: INSTALL_ID, $set: { email: 'member@example.com', email_domain: 'example.com' } }
    });
    const opened = events.filter(item => item.event === 'sidebar_opened');
    expect(opened).toHaveLength(2);
    expect(opened.every(item => item.distinct_id === 'user-42')).toBe(true);
  });

  it('keeps an event anonymous when the session token is invalid', async () => {
    const res = await post('/api/events')
      .set('Authorization', 'Bearer forged.token')
      .send({ installId: INSTALL_ID, events: [{ event: 'signed_out' }] });
    expect(res.status).toBe(202);
    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(1));
    expect(sentEvents()[0].distinct_id).toBe(INSTALL_ID);
  });

  it('sends nothing when the user opted out', async () => {
    const res = await post('/api/events')
      .set('X-Charly-Analytics', 'off')
      .send({ installId: INSTALL_ID, events: [{ event: 'sidebar_opened' }] });
    expect(res.status).toBe(202);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(transport).not.toHaveBeenCalled();
  });

  it('sends nothing for an account blocked by support', async () => {
    const token = app.locals.authTesting.issueSessionToken({ id: 'user-blocked', email: 'blocked@example.com' });
    await post('/api/events')
      .set('Authorization', `Bearer ${token}`)
      .send({ installId: INSTALL_ID, events: [{ event: 'sidebar_opened' }] });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(transport).not.toHaveBeenCalled();
  });

  it('caps a batch at 50 events', async () => {
    const events = Array.from({ length: 120 }, () => ({ event: 'voice_turn', properties: { role: 'user' } }));
    const res = await post('/api/events').send({ installId: INSTALL_ID, events });
    expect(res.body.count).toBe(50);
    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(1));
    expect(sentEvents()).toHaveLength(50);
  });

  it('still accepts legacy batches without forwarding them', async () => {
    const res = await post('/api/events').send({ sid: 'legacy', events: [{ event: 'session_start' }] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, count: 1 });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(transport).not.toHaveBeenCalled();
  });

  it('rejects invalid payloads', async () => {
    expect((await post('/api/events').send({})).status).toBe(400);
    expect((await post('/api/events').send({ installId: INSTALL_ID, events: [] })).status).toBe(400);
  });

  it('does not let a failing PostHog call affect the response', async () => {
    transport.mockRejectedValueOnce(Object.assign(new Error('down'), { code: 'HTTP_503' }));
    const res = await post('/api/events').send({ installId: INSTALL_ID, events: [{ event: 'sidebar_opened' }] });
    expect(res.status).toBe(202);
    await vi.waitFor(() => expect(console.error).toHaveBeenCalledWith(expect.stringContaining('posthog_forward_error')));
  });
});

describe('GET /api/uninstalled', () => {
  it('records the uninstall and redirects to a public page', async () => {
    const res = await supertest(app).get(`/api/uninstalled?iid=${INSTALL_ID}&v=2.2.53`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('https://www.limova.ai/');
    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(1));
    expect(sentEvents()[0]).toMatchObject({
      event: 'extension_uninstalled',
      distinct_id: INSTALL_ID,
      properties: { extension_version: '2.2.53' }
    });
  });

  it('redirects without tracking when the install id is missing', async () => {
    const res = await supertest(app).get('/api/uninstalled');
    expect(res.status).toBe(302);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(transport).not.toHaveBeenCalled();
  });
});

describe('Server-side usage events', () => {
  it('records authenticated API usage with status and latency', async () => {
    const res = await post('/api/copilot/preferences/memory').send({ enabled: 'yes' });
    expect(res.status).toBe(400);
    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(1));
    expect(sentEvents()[0]).toMatchObject({
      event: 'server_memory_preference_changed',
      distinct_id: 'development-user',
      properties: {
        status: 400,
        ok: false,
        enabled: false,
        $set: { email: 'development@limova.ai', auth_provider: 'charly-otp' }
      }
    });
    expect(sentEvents()[0].properties.duration_ms).toEqual(expect.any(Number));
  });

  it('skips server events when the request carries the opt-out header', async () => {
    await post('/api/copilot/preferences/memory').set('X-Charly-Analytics', 'off').send({ enabled: 'yes' });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(transport).not.toHaveBeenCalled();
  });

  it('allows the opt-out header through CORS preflight', async () => {
    const res = await supertest(app)
      .options('/api/copilot/v2/turn')
      .set('Origin', EXT_ORIGIN)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'authorization,content-type,x-charly-analytics');
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-headers']).toMatch(/X-Charly-Analytics/i);
  });
});
