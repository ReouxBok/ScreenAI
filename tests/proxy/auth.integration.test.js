import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const proxyDir = path.resolve(here, '..', '..', 'proxy');
const requireFromProxy = createRequire(path.join(proxyDir, 'package.json'));
const EXT_ID = 'abcdefghijklmnopabcdefghijklmnop';
const EXT_ORIGIN = `chrome-extension://${EXT_ID}`;
const ISSUER = 'https://new.limova.ai';
const AUDIENCE = 'limova-extension';

let app;
let supertest;
let jwksServer;
let privateKey;
let SignJWT;

async function signedToken({ audience = AUDIENCE, subject = 'user-123', expiresIn = '5m' } = {}) {
  let token = new SignJWT({ scope: 'extension:assistant' })
    .setProtectedHeader({ alg: 'RS256', kid: 'integration-key' })
    .setIssuer(ISSUER)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime(expiresIn);
  if (subject) token = token.setSubject(subject);
  return token.sign(privateKey);
}

function postWith(token) {
  const request = supertest(app)
    .post('/api/gemini')
    .set('Origin', EXT_ORIGIN);
  if (token) request.set('Authorization', `Bearer ${token}`);
  return request.send({ contents: [] });
}

beforeAll(async () => {
  const joseEntry = requireFromProxy.resolve('jose');
  const jose = await import(pathToFileURL(joseEntry).href);
  const keyPair = await jose.generateKeyPair('RS256', { extractable: true });
  privateKey = keyPair.privateKey;
  SignJWT = jose.SignJWT;
  const publicJwk = await jose.exportJWK(keyPair.publicKey);
  publicJwk.kid = 'integration-key';
  publicJwk.use = 'sig';
  publicJwk.alg = 'RS256';

  jwksServer = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60' });
    response.end(JSON.stringify({ keys: [publicJwk] }));
  });
  await new Promise(resolve => jwksServer.listen(0, '127.0.0.1', resolve));
  const address = jwksServer.address();

  process.env.NODE_ENV = 'production';
  process.env.EXTENSION_GEMINI_API_KEY = 'integration-test-key';
  process.env.ALLOWED_EXTENSION_ID = EXT_ID;
  process.env.LIMOVA_JWT_ISSUER = ISSUER;
  process.env.LIMOVA_JWT_AUDIENCE = AUDIENCE;
  process.env.LIMOVA_JWKS_URL = `http://127.0.0.1:${address.port}/.well-known/jwks.json`;
  process.env.LIMOVA_READONLY_DATABASE_URL = 'postgresql://unused:unused@localhost/unused';
  process.env.RESEND_API_KEY = 're_test';
  process.env.RESEND_FROM_EMAIL = 'Charly <test@example.com>';
  process.env.CHARLY_SESSION_SECRET = 'integration-session-secret-that-is-long-enough';
  delete process.env.AUTH_DISABLED;

  app = requireFromProxy('./index.js');
  supertest = (await import('supertest')).default;
});

afterAll(async () => {
  await new Promise(resolve => jwksServer.close(resolve));
  process.env.NODE_ENV = 'test';
});

describe('Proxy JWT authentication in production mode', () => {
  it('accepts a persistent Charly OTP session and revalidates its Limova account', async () => {
    app.locals.authDependencies = {
      findActiveUserByEmail: async email => ({ id: 'stable-user-123', email })
    };
    const token = app.locals.authTesting.issueSessionToken({
      id: 'stable-user-123',
      email: 'member@example.com'
    });
    const response = await supertest(app)
      .get('/api/auth/session')
      .set('Origin', EXT_ORIGIN)
      .set('Authorization', `Bearer ${token}`);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      authenticated: true,
      userId: 'stable-user-123',
      provider: 'charly-otp'
    });
    delete app.locals.authDependencies;
    app.locals.authTesting.resetCaches();
  });

  it('rejects a missing bearer token', async () => {
    const response = await postWith(null);
    expect(response.status).toBe(401);
    expect(response.body.error).toBe('Authentication required');
  });

  it('accepts a correctly signed token before validating the payload', async () => {
    const response = await postWith(await signedToken());
    expect(response.status).toBe(400);
    expect(response.body.error).toBe('Invalid conversation payload');
  });

  it('rejects a token for a different audience', async () => {
    const response = await postWith(await signedToken({ audience: 'another-service' }));
    expect(response.status).toBe(401);
    expect(response.body.error).toBe('Invalid or expired token');
  });

  it('rejects an expired token', async () => {
    const response = await postWith(await signedToken({ expiresIn: '0s' }));
    expect(response.status).toBe(401);
  });

  it('rejects a token without subject', async () => {
    const response = await postWith(await signedToken({ subject: null }));
    expect(response.status).toBe(401);
  });
});
