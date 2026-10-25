/**
 * Discord API client
 * One request helper over the REST API, authenticated with the bot token of
 * config.json
 *
 * The token only travels to the configured base URL: redirects are refused
 * rather than followed, and every caller supplied id is checked to be a
 * snowflake so it never climbs to another route
 */

const config = require('../config.json').discordbot;

const USER_AGENT = 'DiscordBot (mcp.js, 1)';
const SNOWFLAKE = /^\d{17,20}$/;

/**
 * Check a snowflake id, the only form a path segment of this API takes
 * @param {*} value
 * @param {string} what Argument name for the error
 * @returns {string}
 */
function snowflake(value, what) {
	const text = value == null ? '' : String(value);
	if (!SNOWFLAKE.test(text)) {
		throw new Error(`Invalid ${what} "${text}", a Discord id`);
	}
	return text;
}

/**
 * Send one request to the API
 * @param {string} method
 * @param {string} route Path under the base URL, ids already checked
 * @param {{query?: object, body?: object}} [options]
 * @returns {Promise<{ok: boolean, status: number, data: *}>} data is the parsed
 * JSON body, or the raw text when the body is not JSON
 */
async function request(method, route, { query, body } = {}) {
	if (!config.token) {
		throw new Error('No Discord bot token, set discordbot.token in config.json');
	}

	const url = new URL(config.baseUrl + route);
	for (const [key, value] of Object.entries(query || {})) {
		if (value != null && value !== '') {
			url.searchParams.set(key, String(value));
		}
	}

	const headers = { Authorization: `Bot ${config.token}`, 'User-Agent': USER_AGENT };
	if (body) {
		headers['Content-Type'] = 'application/json';
	}

	const res = await fetch(url, {
		method,
		headers,
		body: body ? JSON.stringify(body) : undefined,
		redirect: 'error',
		signal: AbortSignal.timeout(config.timeoutMs)
	});

	const text = await res.text();
	let data;
	try {
		data = JSON.parse(text);
	} catch {
		data = text;
	}

	return { ok: res.ok, status: res.status, data };
}

module.exports = { snowflake, request };
