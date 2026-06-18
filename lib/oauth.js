/**
 * Minimal hand-rolled OAuth 2.1 spoof for MCP web connectors
 * Serves the smallest surface a connector needs : dynamic registration,
 * authorize that auto approves, token exchange with client authentication
 * (client_secret_post or basic) and PKCE S256, and a bearer guard on the MCP
 * endpoint
 * The client id and secret are the real gate, checked at the token endpoint,
 * the OAuth shape is interop only
 * (MCP spec 2025-06-18, OAuth 2.1, RFC 7591 / 7636 / 9728)
 */

const crypto = require('crypto');
const config = require('../config.json');

const { enabled, clientId, clientSecret } = config.auth;
const AUTH_ENABLED = Boolean(enabled);

if (
	AUTH_ENABLED &&
	(typeof clientId !== 'string' ||
		clientId.length === 0 ||
		typeof clientSecret !== 'string' ||
		clientSecret.length === 0)
) {
	console.error(
		'[OAuth] auth.enabled=true but auth.clientId or auth.clientSecret is empty, aborting'
	);
	process.exit(1);
}

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

// Guard the MCP endpoint : true when the bearer is a live token, else 401 with
// a challenge pointing at the root protected resource metadata
function guard(req, res) {
	if (!AUTH_ENABLED) {
		return true;
	}
	const header = req.headers.authorization || '';
	const presented = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
	const entry = presented && accessTokens.get(presented);
	if (entry && entry.expiresAt > Date.now()) {
		return true;
	}
	res.writeHead(401, {
		'Content-Type': 'application/json',
		'WWW-Authenticate': `Bearer resource_metadata="${resourceMetadataUrl(req)}"`
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
