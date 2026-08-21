/**
 * Hand-rolled OAuth 2.1 flow plus static bearer for the MCP endpoint
 * auth.mode selects the scheme : none, static, oauth, oauth+static
 * OAuth serves the smallest surface a connector needs : dynamic registration
 * of a public client, an authorize consent form gated by a deployer password,
 * token exchange with PKCE S256 for public clients or client authentication
 * (client_secret_post or basic) for confidential ones
 * Static accepts a long lived bearer matched in constant time, for clients that
 * cannot run the interactive flow
 * The guard accepts a minted token, the static token, or both per mode
 * Minted tokens land one per file under the configured store, each named after
 * the digest of the token so a directory listing carries no credential: a
 * restart keeps connectors authorized, and removing a file revokes it
 * Pure helpers stay at module scope, everything reading the configuration or
 * holding issued credentials lives in the factory closure
 * (MCP spec 2025-06-18, OAuth 2.1, RFC 7591 / 7636 / 9728)
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const VALID_MODES = new Set(['none', 'static', 'oauth', 'oauth+static']);

const CODE_TTL = 60 * 1000;
const ACCESS_TTL = 3600 * 1000;

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

const nonEmpty = (s) => typeof s === 'string' && s.length > 0;

const b64url = (buf) =>
	buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const rand = () => b64url(crypto.randomBytes(32));
const sha256url = (s) => b64url(crypto.createHash('sha256').update(s).digest());
const sha256hex = (s) => crypto.createHash('sha256').update(s).digest('hex');

// One record per file, written aside then renamed, so a reader never sees a
// partial file
function writeRecord(filepath, record) {
	const tmp = `${filepath}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(record), { mode: FILE_MODE });
	fs.renameSync(tmp, filepath);
}

// A file that is missing or unreadable reads as no record, which the callers
// treat as a token that grants nothing
function readRecord(filepath) {
	try {
		return JSON.parse(fs.readFileSync(filepath, 'utf8'));
	} catch (e) {
		return null;
	}
}

// Access records carry an expiry, so the directory drops what no longer grants
function sweepExpired(dir) {
	for (const name of fs.readdirSync(dir)) {
		if (!name.endsWith('.json')) {
			continue;
		}
		const filepath = path.join(dir, name);
		const record = readRecord(filepath);
		if (!record || record.expiresAt < Date.now()) {
			fs.unlinkSync(filepath);
		}
	}
}

// Constant time comparison of two strings, only the length can leak
function safeEqual(presented, expected) {
	const a = Buffer.from(presented, 'utf8');
	const b = Buffer.from(expected, 'utf8');
	if (a.length !== b.length) {
		return false;
	}
	return crypto.timingSafeEqual(a, b);
}

const readBody = (req) =>
	new Promise((resolve) => {
		let body = '';
		req.on('data', (chunk) => (body += chunk.toString()));
		req.on('end', () => resolve(body));
	});

const sendJson = (res, code, obj) => {
	res.writeHead(code, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify(obj));
};

// Protected resource metadata lives at the domain root, built from the Host header
const resourceMetadataUrl = (req) =>
	`https://${req.headers.host}/.well-known/oauth-protected-resource`;

// Client authentication read from the basic header or the form body
function clientCreds(req, params) {
	const header = req.headers.authorization || '';
	if (header.toLowerCase().startsWith('basic ')) {
		const decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8');
		const sep = decoded.indexOf(':');
		return { id: decoded.slice(0, sep), secret: decoded.slice(sep + 1) };
	}
	return { id: params.client_id || '', secret: params.client_secret || '' };
}

// Consent page, the password field is the sole human gate, the OAuth
// parameters stay in the query string and are re-posted to the same URL
// The hidden username gives password managers a stable identity to store
const consentPage = (clientId, error) => `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Authorize connector</title>
<style>
body { font-family: system-ui, sans-serif; display: flex; justify-content: center; margin-top: 20vh; }
form { display: flex; flex-direction: column; gap: 12px; width: 280px; }
input, button { font-size: 16px; padding: 8px; }
.error { color: #b00020; }
</style>
</head>
<body>
<form method="post" action="">
<input type="text" name="username" value="${clientId}" autocomplete="username" readonly hidden>
<label for="password">Authorization password</label>
<input type="password" id="password" name="password" autocomplete="current-password" autofocus>
${error ? '<div class="error">Wrong password</div>' : ''}
<button type="submit">Authorize</button>
</form>
</body>
</html>`;

// Anti framing headers keep the consent click human, immune to clickjacking
function sendConsent(res, clientId, status, error) {
	res.writeHead(status, {
		'Content-Type': 'text/html; charset=utf-8',
		'Cache-Control': 'no-store',
		'X-Frame-Options': 'DENY',
		'Content-Security-Policy': "frame-ancestors 'none'"
	});
	res.end(consentPage(clientId, error));
}

/**
 * Build the OAuth surface for one server configuration
 * @param {object} config - Server configuration holding the auth section
 * @returns {{AUTH_ENABLED: boolean, handle: function, guard: function}}
 */
function createOAuth(config) {
	const { mode, clientId, clientSecret, staticToken, password, storeDir } = config.auth;
	const hasStaticToken = typeof staticToken === 'string' && staticToken.length > 0;
	const OAUTH = mode === 'oauth' || mode === 'oauth+static';
	// Static path is active only with a token, oauth+static stays guarded by OAuth
	// when the token is empty so a deployer can drop one in without a mode change
	const STATIC = (mode === 'static' || mode === 'oauth+static') && hasStaticToken;
	const AUTH_ENABLED = mode !== 'none';

	if (!VALID_MODES.has(mode)) {
		console.error(
			`[OAuth] auth.mode "${mode}" is invalid, expected none, static, oauth or oauth+static`
		);
		process.exit(1);
	}

	if (
		OAUTH &&
		(!nonEmpty(clientId) || !nonEmpty(clientSecret) || !nonEmpty(password) || !nonEmpty(storeDir))
	) {
		console.error(
			'[OAuth] auth.mode needs OAuth but auth.clientId, auth.clientSecret, auth.password or auth.storeDir is empty, aborting'
		);
		process.exit(1);
	}

	// Static only mode is the sole guard, an empty token would leave it open
	if (mode === 'static' && !hasStaticToken) {
		console.error('[OAuth] auth.mode is static but auth.staticToken is empty, aborting');
		process.exit(1);
	}

	// Codes live a minute and stay in memory, tokens live in the store rooted at
	// the project directory, one directory per kind so either can be purged alone
	const codes = new Map();
	const accessDir = OAUTH ? path.resolve(__dirname, '..', storeDir, 'access') : null;
	const refreshDir = OAUTH ? path.resolve(__dirname, '..', storeDir, 'refresh') : null;

	if (OAUTH) {
		fs.mkdirSync(accessDir, { recursive: true, mode: DIR_MODE });
		fs.mkdirSync(refreshDir, { recursive: true, mode: DIR_MODE });
		sweepExpired(accessDir);
	}

	// Dynamic client registration : echo the configured client id as a public
	// client, the consent password and PKCE are its actual gates (RFC 7591)
	async function handleRegister(req, res) {
		const body = await readBody(req);
		let meta = {};
		try {
			meta = JSON.parse(body || '{}');
		} catch (e) {}
		sendJson(res, 201, {
			client_id: clientId,
			redirect_uris: Array.isArray(meta.redirect_uris) ? meta.redirect_uris : [],
			token_endpoint_auth_method: 'none',
			grant_types: ['authorization_code', 'refresh_token'],
			response_types: ['code']
		});
	}

	// Authorize : GET serves the consent form, POST checks the deployer password,
	// binds the PKCE challenge to a fresh code and redirects with code and state
	async function handleAuthorize(req, res) {
		const u = new URL(req.url, `https://${req.headers.host}`);
		const p = Object.fromEntries(u.searchParams);
		let redirect;
		try {
			redirect = new URL(p.redirect_uri || '');
		} catch (e) {
			return sendJson(res, 400, { error: 'invalid_request' });
		}
		if (req.method !== 'POST') {
			return sendConsent(res, clientId, 200, false);
		}
		const form = Object.fromEntries(new URLSearchParams(await readBody(req)));
		if (!safeEqual(form.password || '', password)) {
			return sendConsent(res, clientId, 401, true);
		}
		const code = rand();
		codes.set(code, {
			challenge: p.code_challenge,
			redirectUri: p.redirect_uri,
			expiresAt: Date.now() + CODE_TTL
		});
		redirect.searchParams.set('code', code);
		if (p.state) {
			redirect.searchParams.set('state', p.state);
		}
		res.writeHead(302, { Location: redirect.toString() });
		res.end();
	}

	// A refresh grant hands back the token the client already holds, so the
	// refresh directory keeps one file per consent
	function issueTokens(res, refreshToken) {
		const accessToken = rand();
		const now = Date.now();

		sweepExpired(accessDir);
		writeRecord(path.join(accessDir, `${sha256hex(accessToken)}.json`), {
			client: clientId,
			createdAt: now,
			expiresAt: now + ACCESS_TTL
		});

		sendJson(res, 200, {
			access_token: accessToken,
			token_type: 'Bearer',
			expires_in: ACCESS_TTL / 1000,
			refresh_token: refreshToken
		});
	}

	function mintRefreshToken() {
		const refreshToken = rand();
		writeRecord(path.join(refreshDir, `${sha256hex(refreshToken)}.json`), {
			client: clientId,
			createdAt: Date.now()
		});
		return refreshToken;
	}

	// Token : the client id must match, a presented secret must be correct, an
	// absent secret is a public client whose remaining gate is PKCE, then issue
	async function handleToken(req, res) {
		const p = Object.fromEntries(new URLSearchParams(await readBody(req)));
		const cred = clientCreds(req, p);

		if (cred.id !== clientId || (cred.secret.length > 0 && !safeEqual(cred.secret, clientSecret))) {
			return sendJson(res, 401, { error: 'invalid_client' });
		}

		if (p.grant_type === 'authorization_code') {
			const entry = codes.get(p.code);
			codes.delete(p.code);
			if (!entry || entry.expiresAt < Date.now()) {
				return sendJson(res, 400, { error: 'invalid_grant' });
			}
			if (entry.redirectUri !== p.redirect_uri) {
				return sendJson(res, 400, { error: 'invalid_grant' });
			}
			if (sha256url(p.code_verifier || '') !== entry.challenge) {
				return sendJson(res, 400, { error: 'invalid_grant' });
			}
			return issueTokens(res, mintRefreshToken());
		}

		if (p.grant_type === 'refresh_token') {
			const presented = p.refresh_token;
			if (
				!nonEmpty(presented) ||
				!fs.existsSync(path.join(refreshDir, `${sha256hex(presented)}.json`))
			) {
				return sendJson(res, 400, { error: 'invalid_grant' });
			}
			return issueTokens(res, presented);
		}

		sendJson(res, 400, { error: 'unsupported_grant_type' });
	}

	// Consume the OAuth endpoints, return true when the request is handled
	async function handle(req, res) {
		if (!OAUTH) {
			return false;
		}
		const pathname = req.url.split('?')[0];
		if (pathname.endsWith('/register')) {
			await handleRegister(req, res);
			return true;
		}
		if (pathname.endsWith('/authorize')) {
			await handleAuthorize(req, res);
			return true;
		}
		if (pathname.endsWith('/token')) {
			await handleToken(req, res);
			return true;
		}
		return false;
	}

	// Constant time match of a presented bearer against the configured static token
	function matchStaticToken(presented) {
		return safeEqual(presented, staticToken);
	}

	// Guard the MCP endpoint : accept the static token or a live minted token per
	// mode, else 401 with a challenge pointing at the resource metadata for OAuth
	function guard(req, res) {
		if (!AUTH_ENABLED) {
			return true;
		}
		const header = req.headers.authorization || '';
		const presented = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
		if (presented) {
			if (STATIC && matchStaticToken(presented)) {
				return true;
			}
			// The digest names the file, so a presented token shapes no path
			if (OAUTH) {
				const record = readRecord(path.join(accessDir, `${sha256hex(presented)}.json`));
				if (record && record.expiresAt > Date.now()) {
					return true;
				}
			}
		}
		const challenge = OAUTH ? `Bearer resource_metadata="${resourceMetadataUrl(req)}"` : 'Bearer';
		res.writeHead(401, {
			'Content-Type': 'application/json',
			'WWW-Authenticate': challenge
		});
		res.end(
			JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null })
		);
		return false;
	}

	return { AUTH_ENABLED, handle, guard };
}

module.exports = { createOAuth };
