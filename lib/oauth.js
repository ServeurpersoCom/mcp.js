/**
 * Hand-rolled OAuth 2.1 flow plus static bearer for the MCP endpoint
 * auth.mode selects the scheme : none, static, oauth, oauth+static
 * OAuth serves the smallest surface a connector needs : dynamic registration,
 * authorize that auto approves, token exchange with client authentication
 * (client_secret_post or basic) and PKCE S256
 * Static accepts a long lived bearer matched in constant time, for clients that
 * cannot run the interactive flow
 * The guard accepts a minted token, the static token, or both per mode
 * (MCP spec 2025-06-18, OAuth 2.1, RFC 7591 / 7636 / 9728)
 */

const crypto = require('crypto');
const config = require('../config.json');

const { mode, clientId, clientSecret, staticToken } = config.auth;
const VALID_MODES = new Set(['none', 'static', 'oauth', 'oauth+static']);
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
	(typeof clientId !== 'string' ||
		clientId.length === 0 ||
		typeof clientSecret !== 'string' ||
		clientSecret.length === 0)
) {
	console.error(
		'[OAuth] auth.mode needs OAuth but auth.clientId or auth.clientSecret is empty, aborting'
	);
	process.exit(1);
}

// Static only mode is the sole guard, an empty token would leave it open
if (mode === 'static' && !hasStaticToken) {
	console.error('[OAuth] auth.mode is static but auth.staticToken is empty, aborting');
	process.exit(1);
}

// Pre encode the static token once for constant time comparison in the guard
const STATIC_TOKEN_BUF = STATIC ? Buffer.from(staticToken, 'utf8') : null;

const CODE_TTL = 60 * 1000;
const ACCESS_TTL = 3600 * 1000;

// In memory stores, cleared on restart, the connector re-registers and re-auths
const codes = new Map();
const accessTokens = new Map();
const refreshTokens = new Map();

const b64url = (buf) =>
	buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const rand = () => b64url(crypto.randomBytes(32));
const sha256url = (s) => b64url(crypto.createHash('sha256').update(s).digest());

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

// Dynamic client registration : echo the configured client id (RFC 7591)
async function handleRegister(req, res) {
	const body = await readBody(req);
	let meta = {};
	try {
		meta = JSON.parse(body || '{}');
	} catch (e) {}
	sendJson(res, 201, {
		client_id: clientId,
		redirect_uris: Array.isArray(meta.redirect_uris) ? meta.redirect_uris : [],
		token_endpoint_auth_method: 'client_secret_post',
		grant_types: ['authorization_code', 'refresh_token'],
		response_types: ['code']
	});
}

// Authorize : auto approve, bind the PKCE challenge to a fresh code, redirect
function handleAuthorize(req, res) {
	const u = new URL(req.url, `https://${req.headers.host}`);
	const p = Object.fromEntries(u.searchParams);
	const code = rand();
	codes.set(code, {
		challenge: p.code_challenge,
		redirectUri: p.redirect_uri,
		expiresAt: Date.now() + CODE_TTL
	});
	const redirect = new URL(p.redirect_uri);
	redirect.searchParams.set('code', code);
	if (p.state) {
		redirect.searchParams.set('state', p.state);
	}
	res.writeHead(302, { Location: redirect.toString() });
	res.end();
}

function issueTokens(res) {
	const accessToken = rand();
	const refreshToken = rand();
	accessTokens.set(accessToken, { expiresAt: Date.now() + ACCESS_TTL });
	refreshTokens.set(refreshToken, {});
	sendJson(res, 200, {
		access_token: accessToken,
		token_type: 'Bearer',
		expires_in: ACCESS_TTL / 1000,
		refresh_token: refreshToken
	});
}

// Token : client authentication is the gate, then PKCE S256, then issue
async function handleToken(req, res) {
	const p = Object.fromEntries(new URLSearchParams(await readBody(req)));
	const cred = clientCreds(req, p);

	if (cred.id !== clientId || cred.secret !== clientSecret) {
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
		return issueTokens(res);
	}

	if (p.grant_type === 'refresh_token') {
		if (!refreshTokens.has(p.refresh_token)) {
			return sendJson(res, 400, { error: 'invalid_grant' });
		}
		return issueTokens(res);
	}

	sendJson(res, 400, { error: 'unsupported_grant_type' });
}

// Consume the OAuth endpoints, return true when the request is handled
async function handle(req, res) {
	if (!OAUTH) {
		return false;
	}
	const path = req.url.split('?')[0];
	if (path.endsWith('/register')) {
		await handleRegister(req, res);
		return true;
	}
	if (path.endsWith('/authorize')) {
		handleAuthorize(req, res);
		return true;
	}
	if (path.endsWith('/token')) {
		await handleToken(req, res);
		return true;
	}
	return false;
}

// Constant time match of a presented bearer against the configured static token
function matchStaticToken(presented) {
	if (!STATIC_TOKEN_BUF) {
		return false;
	}
	const buf = Buffer.from(presented, 'utf8');
	if (buf.length !== STATIC_TOKEN_BUF.length) {
		return false;
	}
	return crypto.timingSafeEqual(buf, STATIC_TOKEN_BUF);
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
		if (OAUTH) {
			const entry = accessTokens.get(presented);
			if (entry && entry.expiresAt > Date.now()) {
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

module.exports = {
	AUTH_ENABLED,
	handle,
	guard
};
