/**
 * Phase 6 Comprehensive Verification Suite: Google OAuth & Redis Session Management
 *
 * Tests:
 * 1. Infrastructure connectivity (PostgreSQL, Redis, Elasticsearch)
 * 2. Google OAuth configuration validation (no secrets exposed)
 * 3. OAuth initiation endpoint (GET /api/auth/google) redirect & state generation
 * 4. CSRF state protection & replay attack prevention
 * 5. Unauthenticated rejection (GET /api/auth/me & /api/auth/protected-test)
 * 6. Redis session creation, retrieval, and TTL verification
 * 7. Authenticated access via HTTP-only cookie
 * 8. PostgreSQL user upsert & duplicate prevention
 * 9. Logout flow (Redis session deletion, cookie clearance, idempotent cleanup)
 * 10. Graceful shutdown
 *
 * Run: npx tsx src/scripts/test-suite-phase6.ts
 */
import http from 'http';
import { app } from '../app';
import { config } from '../config/env';
import { connectDatabase, disconnectDatabase, prisma } from '../config/prisma';
import { redisConnection, closeRedisConnection } from '../config/redis';
import { sessionService, SESSION_COOKIE_NAME, OAUTH_STATE_COOKIE_NAME } from '../services/session.service';
import { authService } from '../services/auth.service';
import { elasticsearchService } from '../services/elasticsearch.service';
import { emailService } from '../services/email.service';
import { closeEmailQueue } from '../queues/email.queue';
import { closeEmailWorker } from '../queues/email.worker';

interface TestResult {
  step: string;
  passed: boolean;
  details?: unknown;
  error?: string;
}

const results: TestResult[] = [];

async function logResult(step: string, fn: () => Promise<unknown>) {
  try {
    const details = await fn();
    results.push({ step, passed: true, details });
    console.log(`✅ [PASS] ${step}`);
    if (details !== undefined) {
      const str = JSON.stringify(details, null, 2);
      console.log(`   Details: ${str.length > 800 ? str.slice(0, 800) + '…' : str}`);
    }
  } catch (err) {
    const error = (err as Error).message;
    results.push({ step, passed: false, error });
    console.error(`❌ [FAIL] ${step}: ${error}`);
  }
}

async function runPhase6Suite() {
  console.log('==========================================================');
  console.log('REACHINBOX PHASE 6: GOOGLE OAUTH & SESSION VERIFICATION');
  console.log('==========================================================\n');

  let server: http.Server | null = null;
  const testPort = Number(process.env.TEST_PORT || 4099);
  const baseUrl = `http://localhost:${testPort}`;

  try {
    // ---- A. Infrastructure & Database Connection --------------------------
    await logResult('A. Infrastructure & DB Connection', async () => {
      await connectDatabase();
      const userCount = await prisma.user.count();
      const redisPing = await redisConnection.ping();
      return { dbConnected: true, userCount, redisPing };
    });

    // ---- B. Google OAuth Configuration Verification -----------------------
    await logResult('B. Google OAuth Configuration Loaded', async () => {
      if (!config.google.clientId) {
        throw new Error('Missing GOOGLE_CLIENT_ID in configuration');
      }
      if (!config.google.clientSecret) {
        throw new Error('Missing GOOGLE_CLIENT_SECRET in configuration');
      }
      if (!config.google.callbackUrl) {
        throw new Error('Missing GOOGLE_CALLBACK_URL in configuration');
      }
      return {
        clientId: `${config.google.clientId.slice(0, 16)}...`,
        hasSecret: Boolean(config.google.clientSecret),
        callbackUrl: config.google.callbackUrl,
        frontendUrl: config.frontendUrl,
      };
    });

    // ---- C. Server Startup ------------------------------------------------
    await logResult('C. Server Startup', async () => {
      server = app.listen(testPort);
      await new Promise<void>((resolve) => server!.once('listening', resolve));

      const res = await fetch(`${baseUrl}/api/health`);
      const health = await res.json();
      return { serverListening: true, health };
    });

    // ---- D. OAuth Initiation Endpoint (GET /api/auth/google) ---------------
    await logResult('D. OAuth Initiation Endpoint (GET /api/auth/google)', async () => {
      // Send request without following redirects
      const res = await fetch(`${baseUrl}/api/auth/google`, {
        redirect: 'manual',
      });

      if (res.status !== 302) {
        throw new Error(`Expected HTTP 302 redirect, got: ${res.status}`);
      }

      const location = res.headers.get('location');
      if (!location) {
        throw new Error('Location header missing in redirect');
      }

      const parsedUrl = new URL(location);
      if (!parsedUrl.origin.includes('accounts.google.com')) {
        throw new Error(`Expected Google OAuth URL origin, got: ${parsedUrl.origin}`);
      }

      const clientId = parsedUrl.searchParams.get('client_id');
      const redirectUri = parsedUrl.searchParams.get('redirect_uri');
      const scope = parsedUrl.searchParams.get('scope');
      const state = parsedUrl.searchParams.get('state');

      if (!clientId || clientId !== config.google.clientId) {
        throw new Error('Client ID in Google redirect does not match configured GOOGLE_CLIENT_ID');
      }
      if (!redirectUri || redirectUri !== config.google.callbackUrl) {
        throw new Error('Redirect URI in Google redirect does not match configured GOOGLE_CALLBACK_URL');
      }
      if (!scope || !scope.includes('openid') || !scope.includes('email') || !scope.includes('profile')) {
        throw new Error(`Required OpenID scopes missing, got: ${scope}`);
      }
      if (!state) {
        throw new Error('CSRF state parameter missing in Google redirect');
      }

      // Verify that this state is actively stored in Redis
      const storedInRedis = await redisConnection.get(`oauth_state:${state}`);
      if (!storedInRedis) {
        throw new Error('Generated state parameter was not stored in Redis');
      }

      // Verify that the browser received the temporary HTTP-only SameSite=Lax OAuth state cookie
      const rawCookie = res.headers.get('set-cookie');
      if (!rawCookie || !rawCookie.includes(OAUTH_STATE_COOKIE_NAME)) {
        throw new Error(`OAuth state cookie '${OAUTH_STATE_COOKIE_NAME}' not set in response headers`);
      }
      if (!rawCookie.toLowerCase().includes('httponly')) {
        throw new Error('OAuth state cookie is missing HttpOnly flag');
      }
      if (!rawCookie.toLowerCase().includes('samesite=lax')) {
        throw new Error('OAuth state cookie is missing SameSite=Lax');
      }

      return {
        statusCode: res.status,
        googleAuthHost: parsedUrl.host,
        scope,
        stateStoredInRedis: true,
        browserStateCookieSet: true,
      };
    });

    // ---- E. CSRF State Protection, Browser-Binding & Replay Prevention ---
    await logResult('E. CSRF State Protection, Browser-Binding & Replay Prevention', async () => {
      // 1. Missing code & state
      const missingParamsRes = await fetch(`${baseUrl}/api/auth/google/callback`, { redirect: 'manual' });
      const missingData = (await missingParamsRes.json()) as Record<string, unknown>;
      if (missingParamsRes.status !== 400) {
        throw new Error(`Expected 400 on missing code, got: ${missingParamsRes.status}`);
      }

      // Generate a legitimate server-side state in Redis
      const legitState = await sessionService.createOAuthState();

      // 2. Cross-Browser Attack Scenario A: Valid state in query, but NO cookie in browser
      // (Attacker generates state in their browser, lures victim whose browser has no state cookie)
      const noCookieRes = await fetch(`${baseUrl}/api/auth/google/callback?code=fake_code&state=${legitState}`, {
        redirect: 'manual',
      });
      const noCookieLocation = noCookieRes.headers.get('location') || '';
      if (!noCookieLocation.includes('auth_error=state_cookie_missing')) {
        throw new Error(`Expected redirect with auth_error=state_cookie_missing, got: ${noCookieLocation}`);
      }

      // 3. Cross-Browser Attack Scenario B: Valid state in query, but MISMATCHED cookie in browser
      // (Attacker replaces state parameter with their own state)
      const mismatchedCookieRes = await fetch(`${baseUrl}/api/auth/google/callback?code=fake_code&state=${legitState}`, {
        headers: {
          Cookie: `${OAUTH_STATE_COOKIE_NAME}=attacker_different_state_value`,
        },
        redirect: 'manual',
      });
      const mismatchedLocation = mismatchedCookieRes.headers.get('location') || '';
      if (!mismatchedLocation.includes('auth_error=state_mismatch')) {
        throw new Error(`Expected redirect with auth_error=state_mismatch, got: ${mismatchedLocation}`);
      }

      // 4. Invalid/expired state in Redis (matching cookie, but state not in Redis)
      const invalidRedisState = 'invalid_state_not_in_redis_999999999999999999';
      const invalidStateRes = await fetch(`${baseUrl}/api/auth/google/callback?code=fake_code&state=${invalidRedisState}`, {
        headers: {
          Cookie: `${OAUTH_STATE_COOKIE_NAME}=${invalidRedisState}`,
        },
        redirect: 'manual',
      });
      const invalidLocation = invalidStateRes.headers.get('location') || '';
      if (!invalidLocation.includes('auth_error=invalid_state')) {
        throw new Error(`Expected redirect with auth_error=invalid_state, got: ${invalidLocation}`);
      }

      // 5. One-time atomic state consumption (replay prevention)
      const replayTestState = await sessionService.createOAuthState();
      const firstCheck = await sessionService.verifyOAuthState(replayTestState);
      const secondCheck = await sessionService.verifyOAuthState(replayTestState);

      if (!firstCheck || secondCheck) {
        throw new Error('State was not atomically consumed on first verification (replay vulnerability)');
      }

      return {
        missingCodeRejected: true,
        missingDataError: missingData.message,
        crossBrowserMissingCookieRejected: true,
        crossBrowserStateMismatchRejected: true,
        expiredOrNonexistentStateRejected: true,
        oneTimeStateConsumptionVerified: true,
      };
    });

    // ---- F. Unauthenticated Protection (/api/auth/me & /protected-test) ---
    await logResult('F. Unauthenticated Endpoint Protections', async () => {
      // 1. GET /api/auth/me with no cookie
      const meRes = await fetch(`${baseUrl}/api/auth/me`);
      if (meRes.status !== 401) {
        throw new Error(`Expected 401 for /api/auth/me without cookie, got: ${meRes.status}`);
      }

      // 2. GET /api/auth/protected-test with no cookie
      const protectedRes = await fetch(`${baseUrl}/api/auth/protected-test`);
      if (protectedRes.status !== 401) {
        throw new Error(`Expected 401 for /api/auth/protected-test without cookie, got: ${protectedRes.status}`);
      }

      // 3. GET /api/auth/me with invalid cookie
      const invalidCookieRes = await fetch(`${baseUrl}/api/auth/me`, {
        headers: {
          Cookie: `${SESSION_COOKIE_NAME}=nonexistent_session_id_999`,
        },
      });
      if (invalidCookieRes.status !== 401) {
        throw new Error(`Expected 401 for invalid session cookie, got: ${invalidCookieRes.status}`);
      }

      return {
        unauthenticatedMeBlocked: true,
        unauthenticatedProtectedBlocked: true,
        invalidCookieBlocked: true,
      };
    });

    // ---- G. Redis Session Lifecycle & Storage -----------------------------
    let testSessionId = '';
    const mockUser = {
      userId: 'test-user-uuid-101',
      email: 'alex.developer@reachinbox.ai',
      name: 'Alex Developer',
      avatarUrl: 'https://lh3.googleusercontent.com/a/mock-avatar',
      createdAt: new Date().toISOString(),
    };

    await logResult('G. Redis Session Creation & Storage Verification', async () => {
      testSessionId = await sessionService.createSession(mockUser);

      if (!testSessionId || testSessionId.length < 32) {
        throw new Error('Generated session ID is invalid');
      }

      const retrieved = await sessionService.getSession(testSessionId);
      if (!retrieved || retrieved.userId !== mockUser.userId || retrieved.email !== mockUser.email) {
        throw new Error('Retrieved session from Redis does not match stored data');
      }

      const ttl = await redisConnection.ttl(`session:${testSessionId}`);
      if (ttl <= 0) {
        throw new Error('Redis session key does not have an active TTL');
      }

      return {
        sessionIdLength: testSessionId.length,
        retrievedUser: retrieved.name,
        ttlSeconds: ttl,
        validSessionInRedis: true,
      };
    });

    // ---- H. Authenticated User Flow via Cookie ----------------------------
    await logResult('H. Authenticated User Flow (GET /api/auth/me & /protected-test)', async () => {
      const cookieHeader = `${SESSION_COOKIE_NAME}=${testSessionId}`;

      // 1. GET /api/auth/me with valid session cookie
      const meRes = await fetch(`${baseUrl}/api/auth/me`, {
        headers: { Cookie: cookieHeader },
      });
      const meData = (await meRes.json()) as { authenticated: boolean; user: { email: string; name: string; avatarUrl: string } };

      if (meRes.status !== 200 || !meData.authenticated) {
        throw new Error(`Expected 200 authenticated, got: ${meRes.status} - ${JSON.stringify(meData)}`);
      }
      if (meData.user.email !== mockUser.email || meData.user.name !== mockUser.name) {
        throw new Error('Returned user details do not match session user');
      }

      // 2. GET /api/auth/protected-test with session cookie
      const protectedRes = await fetch(`${baseUrl}/api/auth/protected-test`, {
        headers: { Cookie: cookieHeader },
      });
      const protectedData = (await protectedRes.json()) as { authenticated: boolean };

      if (protectedRes.status !== 200 || !protectedData.authenticated) {
        throw new Error(`Expected 200 for protected route with session cookie, got: ${protectedRes.status}`);
      }

      // 3. Security check: Verify raw Bearer header without cookie is REJECTED (401)
      const bearerRes = await fetch(`${baseUrl}/api/auth/protected-test`, {
        headers: { Authorization: `Bearer ${testSessionId}` },
      });

      if (bearerRes.status !== 401) {
        throw new Error(`Expected 401 for Bearer header (raw session leakage mitigation), got: ${bearerRes.status}`);
      }

      return {
        cookieAuthSuccess: true,
        user: meData.user,
        bearerHeaderRejectedWithoutCookie: true,
      };
    });

    // ---- I. PostgreSQL User Upsert & Deduplication ------------------------
    await logResult('I. PostgreSQL User Upsert & Deduplication', async () => {
      const googlePayload = {
        sub: 'google-oauth-sub-1234567890',
        email: 'intern.tester@reachinbox.ai',
        name: 'Intern Tester Initial',
        picture: 'https://lh3.googleusercontent.com/initial-avatar.jpg',
        email_verified: true,
      };

      // 1. First upsert: user created
      const initialUser = await authService.upsertGoogleUser(googlePayload);
      const countBefore = await prisma.user.count({ where: { googleId: googlePayload.sub } });

      if (!initialUser.id || countBefore !== 1) {
        throw new Error('Failed to create initial user from Google OAuth payload');
      }

      // 2. Second upsert: updated profile info
      const updatedUser = await authService.upsertGoogleUser({
        ...googlePayload,
        name: 'Intern Tester Updated',
        picture: 'https://lh3.googleusercontent.com/updated-avatar.jpg',
      });
      const countAfter = await prisma.user.count({ where: { googleId: googlePayload.sub } });

      if (countAfter !== 1) {
        throw new Error('Duplicate user record created in PostgreSQL for same Google ID');
      }
      if (initialUser.id !== updatedUser.id) {
        throw new Error('User UUID changed on profile update');
      }
      if (updatedUser.name !== 'Intern Tester Updated') {
        throw new Error('User name was not updated in PostgreSQL');
      }

      // Clean up test user
      await prisma.user.delete({ where: { id: initialUser.id } });

      return {
        userCreated: true,
        userId: initialUser.id,
        userUpdated: true,
        noDuplicates: countAfter === 1,
      };
    });

    // ---- J. Logout Flow & Session Destruction -----------------------------
    await logResult('J. Logout Flow & Session Destruction', async () => {
      const logoutSessionId = await sessionService.createSession({
        userId: 'logout-user-uuid',
        email: 'logout@reachinbox.ai',
        name: 'Logout Test User',
        createdAt: new Date().toISOString(),
      });

      // 1. Verify session exists in Redis
      const before = await sessionService.getSession(logoutSessionId);
      if (!before) throw new Error('Session was not created');

      // 2. POST /api/auth/logout with session cookie
      const logoutRes = await fetch(`${baseUrl}/api/auth/logout`, {
        method: 'POST',
        headers: { Cookie: `${SESSION_COOKIE_NAME}=${logoutSessionId}` },
      });
      const logoutData = await logoutRes.json();

      if (logoutRes.status !== 200) {
        throw new Error(`Expected 200 on logout, got: ${logoutRes.status}`);
      }

      // 3. Confirm cookie was cleared in Set-Cookie header
      const setCookie = logoutRes.headers.get('set-cookie');
      if (!setCookie || !setCookie.includes('Max-Age=0') || !setCookie.includes(`${SESSION_COOKIE_NAME}=`)) {
        throw new Error(`Expected Set-Cookie with Max-Age=0, got: ${setCookie}`);
      }

      // 4. Confirm session destroyed in Redis
      const after = await sessionService.getSession(logoutSessionId);
      if (after !== null) {
        throw new Error('Session was not destroyed in Redis after logout');
      }

      // 5. Subsequent call to /api/auth/me with old cookie must return 401
      const meAfterLogout = await fetch(`${baseUrl}/api/auth/me`, {
        headers: { Cookie: `${SESSION_COOKIE_NAME}=${logoutSessionId}` },
      });
      if (meAfterLogout.status !== 401) {
        throw new Error(`Expected 401 after logout, got: ${meAfterLogout.status}`);
      }

      // 6. Idempotent logout (logout when not logged in)
      const emptyLogout = await fetch(`${baseUrl}/api/auth/logout`, { method: 'POST' });
      if (emptyLogout.status !== 200) {
        throw new Error('Logout when already unauthenticated threw error');
      }

      return {
        sessionDestroyedInRedis: true,
        cookieCleared: true,
        meReturns401AfterLogout: true,
        idempotentLogoutSuccess: true,
        logoutResponse: logoutData,
      };
    });

    // ---- K. Graceful Shutdown & Resource Cleanup --------------------------
    await logResult('K. Graceful Shutdown & Resource Cleanup', async () => {
      if (server) {
        await new Promise<void>((resolve) => server!.close(() => resolve()));
      }
      await closeEmailWorker();
      await closeEmailQueue();
      emailService.close();
      await elasticsearchService.close();
      await closeRedisConnection();
      await disconnectDatabase();
      return { allResourcesClosed: true };
    });

  } catch (globalErr) {
    console.error('Fatal Phase 6 suite error:', globalErr);
  } finally {
    console.log('\n==========================================================');
    console.log('PHASE 6 TEST RESULTS SUMMARY');
    console.log('==========================================================');
    const passed = results.filter((r) => r.passed).length;
    console.log(`Passed: ${passed}/${results.length}`);
    for (const r of results) {
      console.log(`${r.passed ? '✅' : '❌'} ${r.step}`);
    }
    console.log('==========================================================');
  }
}

void runPhase6Suite();
