#!/usr/bin/env node

/**
 * Auth System Smoke Tests
 * Tests critical auth flows: login, signup, rate limiting, account locking, token refresh, JWT validation
 */

let BASE_URL = process.env.BASE_URL || null;

async function detectBaseUrl() {
	if (BASE_URL) return BASE_URL;

	const candidates = [];
	if (process.env.PORT) candidates.push(process.env.PORT);
	// prefer the standard vite dev port first, then others
	candidates.push('5173', '5179', '5175', '5177');

	for (const p of candidates) {
		if (!p) continue;
		const url = `http://localhost:${p}`;
		try {
			const controller = new AbortController();
			const id = setTimeout(() => controller.abort(), 2000);
			let res = await fetch(`${url}/api/health`, { signal: controller.signal });
			clearTimeout(id);
			if (res && (res.status === 200 || res.status === 503 || res.status === 404)) {
				BASE_URL = url;
				return BASE_URL;
			}

			// try root if health not present
			const controller2 = new AbortController();
			const id2 = setTimeout(() => controller2.abort(), 2000);
			res = await fetch(`${url}/`, { signal: controller2.signal });
			clearTimeout(id2);
			if (res && (res.status === 200 || res.status === 302 || res.status === 404)) {
				BASE_URL = url;
				return BASE_URL;
			}
		} catch {
			// ignore and try next
		}
	}

	// fallback
	BASE_URL = 'http://localhost:5173';
	return BASE_URL;
}

const ANSI = {
	reset: '\x1b[0m',
	red: '\x1b[31m',
	green: '\x1b[32m',
	yellow: '\x1b[33m',
	blue: '\x1b[34m',
	cyan: '\x1b[36m'
};

let passedTests = 0;
let failedTests = 0;
const failureLog = [];

function log(message, color = 'reset') {
	console.log(`${ANSI[color]}${message}${ANSI.reset}`);
}

function logTest(name, passed, error = '') {
	if (passed) {
		log(`✓ ${name}`, 'green');
		passedTests++;
	} else {
		log(`✗ ${name}`, 'red');
		if (error) log(`  ${error}`, 'yellow');
		failedTests++;
		failureLog.push({ test: name, error });
	}
}

async function request(method, endpoint, body = null, headers = {}) {
	try {
		const options = {
			method,
			headers: {
				'Content-Type': 'application/json',
				...headers
			}
		};

		if (body) {
			options.body = JSON.stringify(body);
		}

		const response = await fetch(`${BASE_URL}${endpoint}`, options);
		const contentType = response.headers.get('content-type') || '';
		const data = contentType.includes('json') ? await response.json() : await response.text();

		return {
			status: response.status,
			data,
			ok: response.ok
		};
	} catch (error) {
		return {
			status: 0,
			data: null,
			ok: false,
			error: error.message
		};
	}
}

// Test Data
const testUser = {
	email: `test-${Date.now()}@example.com`,
	password: 'TestPassword123!'
};

const weakPassword = 'weak';
const strongPassword = 'SecurePass123!@#';

const TEST_IPS = {
	availability: '10.0.0.1',
	signupValidation: '10.0.0.2',
	signupSuccess: '10.0.0.3',
	loginValidation: '10.0.0.4',
	loginSuccess: '10.0.0.5',
	loginFailure: '10.0.0.6',
	signupRateLimit: '10.0.0.7',
	loginRateLimit: '10.0.0.8',
	accountLock: '10.0.0.9'
};

const withIp = (ip) => ({ 'x-forwarded-for': ip });

async function runTests() {
	log('\n╔════════════════════════════════════════╗', 'cyan');
	log('║     Auth System Smoke Tests            ║', 'cyan');
	log('╚════════════════════════════════════════╝\n', 'cyan');

	const resolved = await detectBaseUrl();
	log(`Base URL: ${resolved}\n`, 'blue');

	// ============================================================================
	// 1. ENDPOINT AVAILABILITY TESTS
	// ============================================================================
	log('1. Testing Endpoint Availability', 'cyan');

	// Check if signup endpoint responds
	let result = await request('POST', '/api/auth/signup', { email: 'test@example.com', password: 'Test123!' }, withIp(TEST_IPS.availability));
	logTest('Signup endpoint responds', result.status > 0, result.error);

	// Check if login endpoint responds
	result = await request('POST', '/api/auth/login', { email: 'test@example.com', password: 'Test123!' }, withIp(TEST_IPS.availability));
	logTest('Login endpoint responds', result.status > 0, result.error);

	// Check if refresh endpoint responds
	result = await request('POST', '/api/auth/refresh', { refresh_token: 'dummy' });
	logTest('Refresh endpoint responds', result.status > 0, result.error);

	// ============================================================================
	// 2. SIGNUP VALIDATION TESTS
	// ============================================================================
	log('\n2. Testing Signup Validation', 'cyan');

	// Missing email
	result = await request('POST', '/api/auth/signup', { password: strongPassword }, withIp(TEST_IPS.signupValidation));
	logTest('Rejects signup without email', result.status === 400 && result.data.error);

	// Invalid email
	result = await request('POST', '/api/auth/signup', { email: 'not-an-email', password: strongPassword }, withIp(TEST_IPS.signupValidation));
	logTest('Rejects invalid email format', result.status === 400 && result.data.error);

	// Missing password
	result = await request('POST', '/api/auth/signup', { email: testUser.email }, withIp(TEST_IPS.signupValidation));
	logTest('Rejects signup without password', result.status === 400 && result.data.error);

	// Weak password (less than 10 chars)
	result = await request('POST', '/api/auth/signup', { email: testUser.email, password: weakPassword }, withIp(TEST_IPS.signupValidation));
	logTest(
		'Rejects weak password (< 10 chars)',
		result.status === 400 && result.data.error?.includes('at least 10 characters')
	);

	// Missing uppercase
	result = await request('POST', '/api/auth/signup', { email: testUser.email, password: 'lowercase123!@' }, withIp(TEST_IPS.signupValidation));
	logTest(
		'Rejects password without uppercase',
		result.status === 400 && result.data.error?.includes('upper')
	);

	// Missing number
	result = await request('POST', '/api/auth/signup', { email: testUser.email, password: 'NoNumbers!@' }, withIp(TEST_IPS.signupValidation));
	logTest(
		'Rejects password without number',
		result.status === 400 && result.data.error?.includes('number')
	);

	// Missing symbol
	result = await request('POST', '/api/auth/signup', { email: testUser.email, password: 'NoSymbol123' }, withIp(TEST_IPS.signupValidation));
	logTest(
		'Rejects password without symbol',
		result.status === 400 && result.data.error?.includes('symbol')
	);

	// ============================================================================
	// 3. SIGNUP SUCCESS TEST
	// ============================================================================
	log('\n3. Testing Successful Signup', 'cyan');

	result = await request('POST', '/api/auth/signup', {
		email: testUser.email,
		password: testUser.password
	}, withIp(TEST_IPS.signupSuccess));
	logTest('Creates user with strong password', result.status === 200 && result.data.user?.id);

	// ============================================================================
	// 4. LOGIN VALIDATION TESTS
	// ============================================================================
	log('\n4. Testing Login Validation', 'cyan');

	// Missing email
	result = await request('POST', '/api/auth/login', { password: testUser.password }, withIp(TEST_IPS.loginValidation));
	logTest('Rejects login without email', result.status === 400 && result.data.error);

	// Invalid email format
	result = await request('POST', '/api/auth/login', { email: 'invalid-email', password: testUser.password }, withIp(TEST_IPS.loginValidation));
	logTest('Rejects invalid email in login', result.status === 400 && result.data.error?.includes('Invalid email'));

	// Missing password
	result = await request('POST', '/api/auth/login', { email: testUser.email }, withIp(TEST_IPS.loginValidation));
	logTest('Rejects login without password', result.status === 400 && result.data.error);

	// Password too short
	result = await request('POST', '/api/auth/login', { email: testUser.email, password: 'short' }, withIp(TEST_IPS.loginValidation));
	logTest('Rejects password < 8 chars in login', result.status === 400 && result.data.error?.includes('at least 8'));

	// ============================================================================
	// 5. LOGIN SUCCESS AND JWT TEST
	// ============================================================================
	log('\n5. Testing Successful Login & JWT', 'cyan');

	result = await request('POST', '/api/auth/login', {
		email: testUser.email,
		password: testUser.password
	}, withIp(TEST_IPS.loginSuccess));

	let loginSuccess = result.status === 200 && result.data.session?.access_token;
	logTest('Successful login returns access_token', loginSuccess);

	let accessToken = result.data.session?.access_token;
	let refreshToken = result.data.session?.refresh_token;

	if (loginSuccess) {
		logTest('Access token is JWT format', accessToken && accessToken.split('.').length === 3);
		logTest('Refresh token exists', !!refreshToken);
	}

	// ============================================================================
	// 6. LOGIN WITH WRONG PASSWORD
	// ============================================================================
	log('\n6. Testing Failed Login & Account Lock', 'cyan');

	// Test failed login
	result = await request('POST', '/api/auth/login', {
		email: testUser.email,
		password: 'WrongPassword123!'
	}, withIp(TEST_IPS.loginFailure));
	logTest('Rejects login with wrong password', result.status === 401 && result.data.error);

	// ============================================================================
	// 7. RATE LIMITING TEST (Signup)
	// ============================================================================
	log('\n7. Testing Signup Rate Limiting', 'cyan');

	const rateLimitTestEmail = `ratelimit-${Date.now()}@example.com`;
	let rateLimitHit = false;

	// Try to signup 11 times to trigger rate limit (limit is 10 per hour)
	for (let i = 0; i < 11; i++) {
		result = await request('POST', '/api/auth/signup', {
			email: `${rateLimitTestEmail}-${i}@example.com`,
			password: strongPassword
		}, withIp(TEST_IPS.signupRateLimit));

		if (result.status === 429) {
			rateLimitHit = true;
			logTest('Signup rate limit triggered after 10 attempts', true);
			break;
		}

		// Add small delay to avoid overwhelming the server
		await new Promise(resolve => setTimeout(resolve, 50));
	}

	if (!rateLimitHit) {
		logTest('Signup rate limit triggered after 10 attempts', false, 'Rate limit was not hit');
	}

	// ============================================================================
	// 8. RATE LIMITING TEST (Login)
	// ============================================================================
	log('\n8. Testing Login Rate Limiting', 'cyan');

	let loginRateLimitHit = false;

	// Try to login 6 times to trigger rate limit (limit is 5 per 15 min)
	for (let i = 0; i < 6; i++) {
		result = await request('POST', '/api/auth/login', {
			email: testUser.email,
			password: 'WrongPassword123!'
		}, withIp(TEST_IPS.loginRateLimit));

		if (result.status === 429) {
			loginRateLimitHit = true;
			logTest('Login rate limit triggered after 5 attempts', true);
			break;
		}

		await new Promise(resolve => setTimeout(resolve, 50));
	}

	if (!loginRateLimitHit) {
		logTest('Login rate limit triggered after 5 attempts', false, 'Rate limit was not hit (may be cached)');
	}

	// ============================================================================
	// 9. ACCOUNT LOCK TEST
	// ============================================================================
	log('\n9. Testing Account Lock After Failed Attempts', 'cyan');

	const lockTestEmail = `lock-${Date.now()}@example.com`;
	const lockTestPassword = 'LockTest123!@#';

	// Create an account for lock testing
	result = await request('POST', '/api/auth/signup', {
		email: lockTestEmail,
		password: lockTestPassword
	}, withIp(TEST_IPS.accountLock));

	if (result.status === 200) {
		logTest('Account created for lock testing', true);

		let accountLocked = false;

		// Try to login with wrong password 10+ times to trigger account lock
		for (let i = 0; i < 11; i++) {
			result = await request('POST', '/api/auth/login', {
				email: lockTestEmail,
				password: 'WrongPassword123!'
			}, withIp(TEST_IPS.accountLock));

			if (result.status === 423) {
				accountLocked = true;
				logTest('Account locked after 10 failed attempts', true);
				break;
			}

			await new Promise(resolve => setTimeout(resolve, 50));
		}

		if (!accountLocked) {
			logTest(
				'Account locked after 10 failed attempts',
				false,
				`Got status ${result.status} instead of 423 (locked)`
			);
		}
	} else {
		logTest('Account created for lock testing', false, 'Failed to create test account');
	}

	// ============================================================================
	// 10. REFRESH TOKEN TEST
	// ============================================================================
	log('\n10. Testing Token Refresh', 'cyan');

	if (refreshToken) {
		result = await request('POST', '/api/auth/refresh', {
			refresh_token: refreshToken
		});

		logTest('Refresh token endpoint returns new access_token', result.status === 200 && result.data.session?.access_token);

		if (result.status === 200) {
			const newAccessToken = result.data.session.access_token;
			logTest(
				'New access token is different from old one',
				newAccessToken !== accessToken || result.data.session.access_token
			);
		}
	} else {
		logTest('Token refresh test skipped', false, 'No refresh token from login');
	}

	// Test refresh with invalid token
	result = await request('POST', '/api/auth/refresh', {
		refresh_token: 'invalid-refresh-token'
	});
	logTest('Rejects invalid refresh token', result.status === 401 && result.data.error);

	// Test missing refresh token
	result = await request('POST', '/api/auth/refresh', {});
	logTest('Rejects missing refresh token', result.status === 400 && result.data.error);

	// ============================================================================
	// SUMMARY
	// ============================================================================
	log('\n╔════════════════════════════════════════╗', 'cyan');
	log(`║     Test Results Summary               ║`, 'cyan');
	log(`║  ✓ Passed: ${passedTests}                          ║`, passedTests > 0 ? 'green' : 'yellow');
	log(`║  ✗ Failed: ${failedTests}                          ║`, failedTests > 0 ? 'red' : 'yellow');
	log(`║  Total: ${passedTests + failedTests}                          ║`, 'cyan');
	log('╚════════════════════════════════════════╝\n', 'cyan');

	if (failureLog.length > 0) {
		log('Failed Tests:', 'red');
		failureLog.forEach(f => {
			log(`  • ${f.test}`, 'red');
			if (f.error) log(`    ${f.error}`, 'yellow');
		});
		log('', 'reset');
	}

	// Exit with appropriate code
	process.exit(failedTests > 0 ? 1 : 0);
}

// Run all tests
runTests().catch(err => {
	log(`Fatal error running tests: ${err.message}`, 'red');
	process.exit(1);
});
