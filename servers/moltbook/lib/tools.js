/**
 * Moltbook Tools Module
 * Exposes an agent account on Moltbook, the social network for AI agents, over
 * its REST API
 *
 * - moltbook_home, moltbook_feed, moltbook_read, moltbook_search,
 *   moltbook_profile, moltbook_submolt: read
 * - moltbook_post, moltbook_comment, moltbook_verify, moltbook_vote,
 *   moltbook_follow: write
 *
 * The API key stays in config.json and never reaches the model, so nothing it
 * reads on Moltbook can make it leak the key. No tool fetches the remote
 * skill or heartbeat files: what the agent does is decided by the user and the
 * client prompt alone
 *
 * Every handler returns the API response, rendered as compact JSON and marked
 * as an error on a non 2xx status, 429 and its retry delay included
 */

const { segment, request } = require('./api');
const { textResult } = require('../../../core/tool-result');

const config = require('../config.json').moltbook;

const TOOLS_DEFINITIONS = require('../tools.json').map((tool) => ({
	name: tool.function.name,
	description: tool.function.description,
	inputSchema: tool.function.parameters
}));

/**
 * Render a response, its head kept when it exceeds the output limit
 * @param {{ok: boolean, status: number, data: *}} res
 * @returns {object}
 */
function reply(res) {
	const json = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
	let text = res.ok ? json : `HTTP ${res.status} ${json}`;

	const bytes = Buffer.byteLength(text);
	if (bytes > config.outputLimitBytes) {
		text =
			Buffer.from(text).subarray(0, config.outputLimitBytes).toString() +
			`\n[cut at ${config.outputLimitBytes} of ${bytes} bytes, lower limit or page with cursor]`;
	}

	return textResult(text, !res.ok);
}

/**
 * Turn a handler into a tool, a thrown error becoming an error result
 * @param {function(object): Promise<object>} handler - Resolves to a response
 * @returns {function(object): Promise<object>}
 */
function tool(handler) {
	return async (args) => {
		try {
			return reply(await handler(args));
		} catch (error) {
			return textResult(error.message, true);
		}
	};
}

/**
 * Posts of a community, of the personal feed, or of the whole site
 * @param {{scope?: string, submolt?: string, sort?: string, limit?: number, cursor?: string}} args
 */
async function feed({ scope = 'personal', submolt, sort = 'hot', limit = 10, cursor }) {
	const query = { sort, limit, cursor };

	if (submolt) {
		return request('GET', `/submolts/${segment(submolt, 'submolt')}/feed`, { query });
	}
	if (scope === 'global') {
		return request('GET', '/posts', { query });
	}
	return request('GET', '/feed', {
		query: { ...query, filter: scope === 'following' ? 'following' : 'all' }
	});
}

/**
 * A post with its comment tree, its notifications marked as read the way
 * opening a thread does on the site
 * @param {{post_id: string, sort?: string, limit?: number, cursor?: string}} args
 */
async function read({ post_id, sort = 'best', limit = 35, cursor }) {
	const id = segment(post_id, 'post_id');

	const [post, comments] = await Promise.all([
		request('GET', `/posts/${id}`),
		request('GET', `/posts/${id}/comments`, { query: { sort, limit, cursor } }),
		request('POST', `/notifications/read-by-post/${id}`)
	]);
	if (!post.ok) {
		return post;
	}

	return {
		ok: comments.ok,
		status: comments.status,
		data: { post: post.data, comments: comments.data }
	};
}

/**
 * Semantic search over posts and comments
 * @param {{q: string, type?: string, limit?: number, cursor?: string}} args
 */
async function search({ q, type = 'all', limit = 10, cursor }) {
	return request('GET', '/search', { query: { q, type, limit, cursor } });
}

/**
 * Profile of an agent, or the own profile with its claim status
 * @param {{name?: string}} args
 */
async function profile({ name }) {
	if (name) {
		return request('GET', '/agents/profile', { query: { name } });
	}

	const [me, status] = await Promise.all([
		request('GET', '/agents/me'),
		request('GET', '/agents/status')
	]);
	if (!me.ok) {
		return me;
	}

	return { ok: status.ok, status: status.status, data: { profile: me.data, claim: status.data } };
}

/**
 * Details of a community, or the list of them all
 * @param {{name?: string}} args
 */
async function submolt({ name }) {
	if (name) {
		return request('GET', `/submolts/${segment(name, 'name')}`);
	}
	return request('GET', '/submolts');
}

/**
 * Create a text post, or a link post when url is given
 * @param {{submolt?: string, title: string, content?: string, url?: string}} args
 */
async function post({ submolt = 'general', title, content, url }) {
	return request('POST', '/posts', {
		body: { submolt_name: submolt, title, content, url, type: url ? 'link' : 'text' }
	});
}

/**
 * Comment on a post, or reply to one of its comments
 * @param {{post_id: string, content: string, parent_id?: string}} args
 */
async function comment({ post_id, content, parent_id }) {
	return request('POST', `/posts/${segment(post_id, 'post_id')}/comments`, {
		body: { content, parent_id }
	});
}

/**
 * Answer the verification challenge of a post or comment
 * @param {{verification_code: string, answer: string}} args
 */
async function verify({ verification_code, answer }) {
	return request('POST', '/verify', { body: { verification_code, answer: String(answer) } });
}

/**
 * Vote on a post or a comment
 * @param {{kind: string, id: string, direction?: string}} args
 */
async function vote({ kind, id, direction = 'up' }) {
	const target = { post: 'posts', comment: 'comments' }[kind];
	if (!target) {
		throw new Error(`Invalid kind "${kind}", post or comment`);
	}
	const action = direction === 'down' ? 'downvote' : 'upvote';
	return request('POST', `/${target}/${segment(id, 'id')}/${action}`);
}

/**
 * Follow an agent or subscribe to a community, or undo it
 * @param {{kind: string, name: string, follow?: boolean}} args
 */
async function follow({ kind, name, follow = true }) {
	const route = {
		agent: `/agents/${segment(name, 'name')}/follow`,
		submolt: `/submolts/${segment(name, 'name')}/subscribe`
	}[kind];
	if (!route) {
		throw new Error(`Invalid kind "${kind}", agent or submolt`);
	}
	return request(follow === false ? 'DELETE' : 'POST', route);
}

const TOOLS_MAPPING = {
	moltbook_home: tool(() => request('GET', '/home')),
	moltbook_feed: tool(feed),
	moltbook_read: tool(read),
	moltbook_search: tool(search),
	moltbook_profile: tool(profile),
	moltbook_submolt: tool(submolt),
	moltbook_post: tool(post),
	moltbook_comment: tool(comment),
	moltbook_verify: tool(verify),
	moltbook_vote: tool(vote),
	moltbook_follow: tool(follow)
};

module.exports = {
	TOOLS_DEFINITIONS,
	TOOLS_MAPPING
};
