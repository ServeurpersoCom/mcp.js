/**
 * Chrome DevTools Protocol client
 * A generic CDP connection over the WebSocket a debugging port exposes, enough
 * to pick a target and evaluate one expression in it
 *
 * It carries no Discord knowledge: it finds a target by its URL prefix and runs
 * a snippet through Runtime.evaluate, so the same client drives any Electron app
 * or a headless Chromium started with --remote-debugging-port
 */

const WS_OPEN = 1;

/**
 * List the debugging targets of a port
 * @param {string} origin http://host:port of the debugging endpoint
 * @param {number} timeoutMs
 * @returns {Promise<object[]>}
 */
async function targets(origin, timeoutMs) {
	const res = await fetch(`${origin}/json/list`, {
		signal: AbortSignal.timeout(timeoutMs)
	});
	if (!res.ok) {
		throw new Error(`Debugging port answered HTTP ${res.status}`);
	}
	return res.json();
}

/**
 * The version banner of a port, also the readiness probe of a fresh tunnel
 * @param {string} origin
 * @param {number} timeoutMs
 * @returns {Promise<object>}
 */
async function version(origin, timeoutMs) {
	const res = await fetch(`${origin}/json/version`, {
		signal: AbortSignal.timeout(timeoutMs)
	});
	if (!res.ok) {
		throw new Error(`Debugging port answered HTTP ${res.status}`);
	}
	return res.json();
}

/**
 * The page target whose URL starts with a prefix, the main window rather than a
 * worker or a devtools view
 * @param {string} origin
 * @param {string} urlPrefix
 * @param {number} timeoutMs
 * @returns {Promise<object>}
 */
async function pageTarget(origin, urlPrefix, timeoutMs) {
	const list = await targets(origin, timeoutMs);
	const page = list.find((t) => t.type === 'page' && (t.url || '').startsWith(urlPrefix));
	if (!page) {
		throw new Error(`No page of ${urlPrefix} on the debugging port, is the app open`);
	}
	return page;
}

/**
 * Evaluate one expression in a target and return its value
 * The expression is awaited and returned by value, so the snippet speaks plain
 * JSON back and the socket closes with the call
 * @param {string} webSocketDebuggerUrl
 * @param {string} expression
 * @param {number} timeoutMs
 * @returns {Promise<*>}
 */
function evaluate(webSocketDebuggerUrl, expression, timeoutMs) {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(webSocketDebuggerUrl);
		const timer = setTimeout(() => {
			close();
			reject(new Error(`CDP evaluate timed out after ${timeoutMs} ms`));
		}, timeoutMs);

		function close() {
			clearTimeout(timer);
			if (ws.readyState === WS_OPEN) {
				ws.close();
			}
		}

		ws.onerror = () => {
			close();
			reject(new Error('CDP socket error'));
		};
		ws.onopen = () => {
			ws.send(
				JSON.stringify({
					id: 1,
					method: 'Runtime.evaluate',
					params: { expression, returnByValue: true, awaitPromise: true }
				})
			);
		};
		ws.onmessage = (event) => {
			let message;
			try {
				message = JSON.parse(event.data);
			} catch {
				return;
			}
			if (message.id !== 1) {
				return;
			}
			close();
			const result = message.result;
			if (result && result.exceptionDetails) {
				const detail = result.exceptionDetails;
				const text = detail.exception ? detail.exception.description : detail.text;
				reject(new Error(`Page error: ${(text || '').split('\n')[0]}`));
				return;
			}
			resolve(result && result.result ? result.result.value : undefined);
		};
	});
}

module.exports = { targets, version, pageTarget, evaluate };
