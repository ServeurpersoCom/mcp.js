/**
 * Browser session
 * One WebDriver BiDi session with the browser, opened by the first call and
 * kept while calls come, so tabs, refs, dialogs and the console messages of
 * the current tab carry from one call to the next; it ends after idleMs
 * without a call, which frees the browser for other clients
 *
 * The browser keeps a session whose connection drops, and ends one only when
 * asked over a live connection, so the session is always ended by an answered
 * session.end, never by closing the socket
 *
 * The browser runs already, started with --remote-debugging-port, and config
 * gives its endpoint
 *
 * Calls run one at a time: the session is a single state, and a browser takes
 * one session
 */

const { connect } = require('../../../core/bidi');
const { PAGE } = require('./page');

const config = require('../config.json').browser;

const SANDBOX = 'mcp';
const EVENTS = [
	'browsingContext.contextCreated',
	'browsingContext.contextDestroyed',
	'browsingContext.navigationStarted',
	'browsingContext.navigationFailed',
	'browsingContext.load',
	'browsingContext.userPromptOpened',
	'browsingContext.userPromptClosed',
	'input.fileDialogOpened',
	'log.entryAdded',
	'network.beforeRequestSent',
	'network.responseCompleted',
	'network.fetchError'
];
const PAGE_CALL = `(op, json, node) => JSON.stringify((${PAGE})(op, JSON.parse(json), node) ?? null)`;
const PAGE_NODE = `(op, json) => (${PAGE})(op, JSON.parse(json))`;

let link = null;
let chain = Promise.resolve();
let idle = null;
let wake = null;
let state = fresh();

function fresh() {
	return {
		platform: '',
		context: null,
		prompt: null,
		onPrompt: null,
		fileDialog: null,
		opened: [],
		console: [],
		loading: false,
		requests: null
	};
}

function onEvent(method, params) {
	switch (method) {
		case 'browsingContext.contextCreated':
			if (!params.parent) {
				state.opened.push(params.context);
			}
			break;
		case 'browsingContext.contextDestroyed':
			if (params.context === state.context) {
				state.context = null;
			}
			break;
		case 'browsingContext.navigationStarted':
			if (params.context === state.context) {
				state.loading = true;
			}
			break;
		case 'browsingContext.load':
		case 'browsingContext.navigationFailed':
			if (params.context === state.context) {
				state.loading = false;
				nudge();
			}
			break;
		case 'network.beforeRequestSent':
			if (state.requests && params.context === state.context) {
				state.requests.add(params.request.request);
			}
			break;
		case 'network.responseCompleted':
		case 'network.fetchError':
			if (state.requests) {
				state.requests.delete(params.request.request);
				nudge();
			}
			break;
		case 'browsingContext.userPromptOpened':
			state.prompt = params;
			if (state.onPrompt) {
				state.onPrompt();
			}
			break;
		case 'browsingContext.userPromptClosed':
			state.prompt = null;
			break;
		case 'input.fileDialogOpened':
			state.fileDialog = params;
			break;
		case 'log.entryAdded':
			if (params.source.context !== state.context) {
				break;
			}
			state.console.push(
				`${params.level} ${params.type === 'console' ? params.method : params.type}: ${params.text}`
			);
			if (state.console.length > config.consoleEntries) {
				state.console.shift();
			}
			break;
	}
}

function onClose() {
	link = null;
	state = fresh();
}

async function open() {
	const origin = config.connect;
	const url = `${origin}/session`;
	try {
		link = await connect(url, config.timeoutMs, onEvent, onClose);
	} catch (error) {
		throw new Error(`${error.message}, is the browser running with --remote-debugging-port`);
	}
	let created;
	try {
		created = await link.call('session.new', {
			capabilities: { alwaysMatch: { unhandledPromptBehavior: { default: 'ignore' } } }
		});
	} catch (error) {
		link.close();
		if (error.code === 'session not created') {
			throw new Error(
				`${origin} runs a WebDriver session already, another client holds it or one that died left it; restarting the browser frees it`
			);
		}
		throw error;
	}
	state.platform = created.capabilities.platformName;
	try {
		await link.call('session.subscribe', { events: EVENTS });
	} catch (error) {
		await end();
		throw error;
	}
	state.opened = [];
}

async function end() {
	const current = link;
	if (!current) {
		return;
	}
	link = null;
	try {
		await current.call('session.end');
	} finally {
		current.close();
	}
}

/**
 * Run fn with the session, opened when none is; calls queue one behind the
 * other, and the session ends once idleMs pass after the last one
 * @param {function(object): Promise<*>} fn
 * @returns {Promise<*>}
 */
function session(fn) {
	const run = chain.then(async () => {
		clearTimeout(idle);
		try {
			if (!link) {
				await open();
			}
			return await fn(api);
		} finally {
			idle = setTimeout(() => {
				chain = chain.then(end).catch(() => {});
			}, config.idleMs);
			idle.unref();
		}
	});
	chain = run.catch(() => {});
	return run;
}

function call(method, params) {
	return link.call(method, params);
}

/**
 * Run input actions; a dialog they open holds the command until it is
 * answered, so the dialog opening ends the wait
 * @param {string} context
 * @param {object[]} actions
 * @returns {Promise<void>}
 */
function perform(context, actions) {
	const done = call('input.performActions', { context, actions });
	const opened = new Promise((resolve) => {
		state.onPrompt = resolve;
	});
	return Promise.race([done, opened]).finally(() => {
		state.onPrompt = null;
		done.catch(() => {});
	});
}

function exception(result) {
	const detail = result.exceptionDetails || {};
	return new Error((detail.text || 'Page error').replace(/^Error: /, ''));
}

/**
 * Run an op of the page function in the sandbox of a context
 * @param {string} context
 * @param {string} op
 * @param {object=} args
 * @param {string=} sharedId An element handed to the op
 * @returns {Promise<*>}
 */
async function page(context, op, args = {}, sharedId) {
	const parameters = [
		{ type: 'string', value: op },
		{ type: 'string', value: JSON.stringify(args) }
	];
	if (sharedId) {
		parameters.push({ sharedId });
	}
	const result = await call('script.callFunction', {
		functionDeclaration: PAGE_CALL,
		target: { context, sandbox: SANDBOX },
		arguments: parameters,
		awaitPromise: false
	});
	if (result.type === 'exception') {
		throw exception(result);
	}
	return JSON.parse(result.result.value);
}

/**
 * The shared id of the element a ref names, for the commands that take a node
 * @param {string} context
 * @param {string} ref
 * @returns {Promise<string>}
 */
async function element(context, ref) {
	const result = await call('script.callFunction', {
		functionDeclaration: PAGE_NODE,
		target: { context, sandbox: SANDBOX },
		arguments: [
			{ type: 'string', value: 'element' },
			{ type: 'string', value: JSON.stringify({ ref }) }
		],
		awaitPromise: false,
		resultOwnership: 'root'
	});
	if (result.type === 'exception') {
		throw exception(result);
	}
	return result.result.sharedId;
}

/**
 * The top level contexts, the tabs, in the order of the tab bar
 * @returns {Promise<object[]>}
 */
async function tabs() {
	const tree = await call('browsingContext.getTree', { maxDepth: 0 });
	return tree.contexts;
}

/**
 * The current tab: the one the last call worked in, or else the tab the
 * browser shows, or else a new one
 * @returns {Promise<string>}
 */
async function context() {
	if (state.context) {
		return state.context;
	}
	const list = await tabs();
	for (const tab of list) {
		const info = await page(tab.context, 'info').catch(() => null);
		if (info && info.visible) {
			state.context = tab.context;
			return state.context;
		}
	}
	if (list.length) {
		state.context = list[0].context;
		return state.context;
	}
	state.context = (await call('browsingContext.create', { type: 'tab' })).context;
	return state.context;
}

function select(context) {
	state.context = context;
	state.loading = false;
}

function nudge() {
	if (wake) {
		wake();
	}
}

/**
 * Wait until ready() holds, an event nudging the check, or ms pass
 * @param {function(): boolean} ready
 * @param {number} ms
 * @returns {Promise<void>}
 */
function until(ready, ms) {
	return new Promise((resolve) => {
		if (ready()) {
			resolve();
			return;
		}
		const done = () => {
			clearTimeout(timer);
			wake = null;
			resolve();
		};
		const timer = setTimeout(done, ms);
		wake = () => {
			if (ready()) {
				done();
			}
		};
	});
}

/**
 * Watch the requests the current tab sends from now on, for settle
 */
function begin() {
	state.requests = new Set();
}

/**
 * Wait settleMs for what an action starts, then up to networkMs for the
 * requests it sent, a single page app fetching its next view, then for the
 * load of a navigation
 * @returns {Promise<void>}
 */
async function settle() {
	await new Promise((resolve) => setTimeout(resolve, config.settleMs));
	await until(() => !state.requests || !state.requests.size, config.networkMs);
	await until(() => !state.loading, config.timeoutMs);
	state.requests = null;
}

/**
 * A URL as a result shows it, cut after urlChars
 * @param {string} url
 * @returns {string}
 */
function shorten(url) {
	return url.length > config.urlChars ? url.slice(0, config.urlChars) + '...' : url;
}

/**
 * The lines that end an action: the page it left, then any dialog, file
 * chooser or tab it opened
 * @param {string} context
 * @returns {Promise<string>}
 */
async function footer(context) {
	const lines = [];
	const current = state.context || context;
	const info = await page(current, 'info').catch(() => null);
	if (info) {
		lines.push(`Page: ${JSON.stringify(info.title)} ${shorten(info.url)}`);
	}
	if (state.prompt) {
		const p = state.prompt;
		lines.push(
			`Dialog open: ${p.type} ${JSON.stringify(p.message)}, answer it with browser_handle_dialog`
		);
	}
	if (state.fileDialog) {
		const f = state.fileDialog;
		const ref = await page(f.context, 'ref', {}, f.element.sharedId).catch(() => null);
		lines.push(
			`File chooser open${ref ? ` for ${ref}` : ''}, give it files with browser_file_upload`
		);
	}
	if (state.opened.length) {
		const list = await tabs();
		for (const id of state.opened) {
			const index = list.findIndex((t) => t.context === id);
			if (index >= 0) {
				lines.push(
					`New tab ${index}: ${shorten(list[index].url)}, browser_tabs select to work in it`
				);
			}
		}
		state.opened = [];
	}
	return lines.length ? '\n' + lines.join('\n') : '';
}

const api = {
	call,
	perform,
	page,
	element,
	tabs,
	context,
	select,
	begin,
	settle,
	shorten,
	footer,
	state: () => state
};

module.exports = { session };
