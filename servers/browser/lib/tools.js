/**
 * Browser tools
 * Drives a Firefox over WebDriver BiDi, the way a person uses it: read the
 * page as an accessibility outline, act on its elements by the refs the
 * outline gives, see it in screenshots
 *
 * - browser_navigate, browser_navigate_back, browser_tabs: where the browser is
 * - browser_snapshot: the page as an outline of roles, names and refs
 * - browser_take_screenshot: the viewport, the whole page, a region or an
 *   element, as an image
 * - browser_wait_for: a text to appear or to go, or some seconds
 * - browser_click, browser_type, browser_fill_form, browser_select_option,
 *   browser_press_key, browser_hover, browser_drag, browser_drag_to_offset:
 *   real input on the elements a ref names, scrolled into view first and
 *   checked visible, enabled and not covered
 * - browser_handle_dialog: the dialog an action opened
 * - browser_console: the console messages and page errors since the last read
 * - browser_eval: a script run in the page, its value
 *
 * The pointer and the keyboard are the browser's own input, so the page gets
 * the events a person makes; text fields are filled at once unless typed
 * slowly
 */

const sharp = require('sharp');
const { session } = require('./session');
const { imageResults } = require('../../../core/image');
const { textResult } = require('../../../core/tool-result');

const config = require('../config.json').browser;

const TOOLS_DEFINITIONS = require('../tools.json').map((tool) => ({
	name: tool.function.name,
	description: tool.function.description,
	inputSchema: tool.function.parameters
}));

const REF = /^e\d+$/;
const UNKNOWN = /^unknown error: (Error: )?/;
const MOUSE = 'mouse';
const KEYBOARD = 'keyboard';
const BUTTONS = { left: 0, middle: 1, right: 2 };
const MODIFIERS = ['Alt', 'Control', 'ControlOrMeta', 'Meta', 'Shift'];
const MAC = 'mac';
const KEYS = {
	Unidentified: '',
	Cancel: '',
	Help: '',
	Backspace: '',
	Tab: '',
	Clear: '',
	Enter: '',
	Shift: '',
	Control: '',
	Alt: '',
	Pause: '',
	Escape: '',
	PageUp: '',
	PageDown: '',
	End: '',
	Home: '',
	ArrowLeft: '',
	ArrowUp: '',
	ArrowRight: '',
	ArrowDown: '',
	Insert: '',
	Delete: '',
	F1: '',
	F2: '',
	F3: '',
	F4: '',
	F5: '',
	F6: '',
	F7: '',
	F8: '',
	F9: '',
	F10: '',
	F11: '',
	F12: '',
	Meta: ''
};
const KEY_JOIN = '+';
const TAB_ACTIONS = ['list', 'new', 'close', 'select'];
const FIELD_TYPES = ['textbox', 'checkbox', 'radio', 'combobox', 'slider'];
const SHOT_TYPES = { png: 'image/png', jpeg: 'image/jpeg' };
const SCALE_MAX = 4;
const MS = 1000;
const IMAGE_LIMITS = {
	pixels: config.maxMegapixels * 1000000,
	side: config.maxDimension,
	quality: config.jpegQuality
};
const JPEG_QUALITY = config.jpegQuality / 100;
const segmenter = new Intl.Segmenter();

/**
 * Turn a handler into a tool, a thrown error becoming an error result and the
 * text keeping its head when it exceeds the output limit; results a handler
 * already made, an image, pass as they are
 * @param {function(object): Promise<string|object|object[]>} handler
 * @returns {function(object): Promise<object>}
 */
function tool(handler) {
	return async (args) => {
		try {
			let text = await handler(args);
			if (typeof text !== 'string') {
				return text;
			}
			const bytes = Buffer.byteLength(text);
			if (bytes > config.outputLimitBytes) {
				text =
					Buffer.from(text).subarray(0, config.outputLimitBytes).toString() +
					`\n[cut at ${config.outputLimitBytes} of ${bytes} bytes]`;
			}
			return textResult(text);
		} catch (error) {
			return textResult(error.message, true);
		}
	};
}

/**
 * The ref a target names: a ref from the snapshot, then optionally words
 * describing the element, "e12 Search box"
 * @param {string} target
 * @param {string} what Argument name for the error
 * @returns {string}
 */
function refOf(target, what) {
	const ref = String(target).trim().split(/\s+/)[0];
	if (!REF.test(ref)) {
		throw new Error(`Invalid ${what} "${target}", a ref from the snapshot such as e12`);
	}
	return ref;
}

function flag(value, what) {
	if (value != null && typeof value !== 'boolean') {
		throw new Error(`${what} argument is not a boolean`);
	}
	return value === true;
}

function number(value, what) {
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		throw new Error(`${what} argument is not a number`);
	}
	return value;
}

function strings(value, what) {
	if (!Array.isArray(value) || !value.length || value.some((v) => typeof v !== 'string')) {
		throw new Error(`${what} argument is not a list of strings`);
	}
	return value;
}

/**
 * The WebDriver value of a key name, a DOM key name such as Enter or a single
 * character
 * @param {string} name
 * @param {string} platform
 * @returns {string}
 */
function keyValue(name, platform) {
	if (name === 'ControlOrMeta') {
		return platform === MAC ? KEYS.Meta : KEYS.Control;
	}
	if (KEYS[name]) {
		return KEYS[name];
	}
	if ([...segmenter.segment(name)].length === 1) {
		return name;
	}
	throw new Error(
		`Unknown key "${name}", a key name such as Enter, ArrowLeft or Control, or one character`
	);
}

/**
 * The keys of a press: one key, or a chord such as Control+a or Control++
 * @param {string} key
 * @param {string} platform
 * @returns {string[]}
 */
function chord(key, platform) {
	const parts = key.length > 1 ? key.split(KEY_JOIN) : [key];
	if (parts.length > 2 && parts.at(-1) === '' && parts.at(-2) === '') {
		parts.splice(-2, 2, KEY_JOIN);
	}
	if (parts.includes('')) {
		throw new Error(`Invalid key "${key}", keys joined by + such as Control+a`);
	}
	return parts.map((p) => keyValue(p, platform));
}

function keyActions(values) {
	return [
		{
			type: 'key',
			id: KEYBOARD,
			actions: [
				...values.map((value) => ({ type: 'keyDown', value })),
				...values
					.slice()
					.reverse()
					.map((value) => ({ type: 'keyUp', value }))
			]
		}
	];
}

function typeActions(text) {
	const actions = [];
	for (const { segment } of segmenter.segment(text)) {
		actions.push({ type: 'keyDown', value: segment }, { type: 'keyUp', value: segment });
	}
	return [{ type: 'key', id: KEYBOARD, actions }];
}

/**
 * Pointer steps with modifier keys held around them
 * @param {object[]} steps
 * @param {string[]} keys WebDriver key values
 * @returns {object[]}
 */
function pointerActions(steps, keys = []) {
	const pointer = {
		type: 'pointer',
		id: MOUSE,
		parameters: { pointerType: 'mouse' },
		actions: [...keys.map(() => ({ type: 'pause', duration: 0 })), ...steps]
	};
	if (!keys.length) {
		return [pointer];
	}
	const keyboard = {
		type: 'key',
		id: KEYBOARD,
		actions: [
			...keys.map((value) => ({ type: 'keyDown', value })),
			...steps.map(() => ({ type: 'pause', duration: 0 })),
			...keys
				.slice()
				.reverse()
				.map((value) => ({ type: 'keyUp', value }))
		]
	};
	return [keyboard, pointer];
}

function at({ x, y }) {
	return { type: 'pointerMove', x: Math.round(x), y: Math.round(y) };
}

function perform(s, context, actions) {
	return s.perform(context, actions);
}

async function clickAt(s, context, ref, steps = 1, button = BUTTONS.left, keys = []) {
	const point = await s.page(context, 'locate', { ref, scroll: true, enabled: true, hit: true });
	const press = [];
	for (let i = 0; i < steps; i++) {
		press.push({ type: 'pointerDown', button }, { type: 'pointerUp', button });
	}
	await perform(s, context, pointerActions([at(point), ...press], keys));
}

/**
 * Run an action in the current tab, then let it settle and say where it left
 * the browser
 * @param {function(object, string): Promise<string>} fn
 * @returns {Promise<string>}
 */
function act(fn) {
	return session(async (s) => {
		const context = await s.context();
		s.begin();
		const done = await fn(s, context);
		await s.settle();
		return done + (await s.footer(context));
	});
}

function navigate({ url }) {
	return act(async (s, context) => {
		try {
			await s.call('browsingContext.navigate', { context, url, wait: 'complete' });
		} catch (error) {
			if (/no answer/.test(error.message)) {
				return `Navigated, still loading after ${config.timeoutMs} ms`;
			}
			if (error.code === 'unsupported operation') {
				throw new Error('Firefox does not open this address from a script');
			}
			if (error.code === 'invalid argument') {
				throw new Error('Invalid URL, a full address such as https://example.com');
			}
			if (error.code === 'unknown error') {
				throw new Error(`Cannot open the page: ${error.message.replace(UNKNOWN, '')}`);
			}
			throw error;
		}
		return 'Navigated';
	});
}

function navigateBack() {
	return act(async (s, context) => {
		try {
			await s.call('browsingContext.traverseHistory', { context, delta: -1 });
		} catch (error) {
			if (error.code === 'no such history entry') {
				throw new Error('No page to go back to');
			}
			throw error;
		}
		return 'Went back';
	});
}

function tabs({ action, index }) {
	if (!TAB_ACTIONS.includes(action)) {
		throw new Error(`Invalid action "${action}", one of ${TAB_ACTIONS.join(', ')}`);
	}
	if (index != null && (!Number.isInteger(index) || index < 0)) {
		throw new Error(`Invalid index "${index}", a tab number from browser_tabs list`);
	}
	return session(async (s) => {
		const current = await s.context();
		const list = await s.tabs();
		const pick = () => {
			const at = index == null ? list.findIndex((t) => t.context === current) : index;
			if (!list[at]) {
				throw new Error(`No tab ${index}, browser_tabs list gives ${list.length}`);
			}
			return list[at].context;
		};
		if (action === 'new') {
			const { context } = await s.call('browsingContext.create', { type: 'tab' });
			s.state().opened = [];
			s.select(context);
			return `Opened tab ${list.length}` + (await s.footer(context));
		}
		if (action === 'close') {
			const context = pick();
			await s.call('browsingContext.close', { context });
			if (context === current) {
				s.select(null);
			}
			return `Closed tab ${list.findIndex((t) => t.context === context)}`;
		}
		if (action === 'select') {
			if (index == null) {
				throw new Error('Index argument required to select a tab');
			}
			const context = pick();
			await s.call('browsingContext.activate', { context });
			s.select(context);
			return `Selected tab ${index}` + (await s.footer(context));
		}
		const lines = [];
		for (const [i, tab] of list.entries()) {
			const info = await s.page(tab.context, 'info').catch(() => ({ title: '' }));
			lines.push(
				`${i}${tab.context === current ? ' [current]' : ''}: ${JSON.stringify(info.title)} ${s.shorten(tab.url)}`
			);
		}
		return lines.join('\n');
	});
}

function snapshot({ ref, depth, filter, find, max_chars, offset }) {
	const root = ref == null ? undefined : refOf(ref, 'ref');
	if (depth != null && (!Number.isInteger(depth) || depth < 0)) {
		throw new Error(`Invalid depth "${depth}", a whole number of levels`);
	}
	if (filter != null && filter !== 'interactive') {
		throw new Error(`Invalid filter "${filter}", only interactive`);
	}
	const size =
		max_chars == null
			? config.snapshotChars
			: Math.min(Math.max(Math.trunc(number(max_chars, 'Max_chars')), 1), config.snapshotChars);
	const from = offset == null ? 0 : Math.max(Math.trunc(number(offset, 'Offset')), 0);
	return session(async (s) => {
		const context = await s.context();
		const info = await s.page(context, 'info');
		const outline = await s.page(context, 'snapshot', { ref: root, depth, filter, find });
		let text = outline.slice(from, from + size);
		if (from + size < outline.length) {
			text += `\nmore: offset=${from + size}`;
		}
		const head = `Page: ${JSON.stringify(info.title)} ${s.shorten(info.url)}`;
		return `${head}\n${text || (find ? 'No match' : 'Nothing shown')}`;
	});
}

function screenshot({ target, fullPage, region, scale, type }) {
	const ref = target == null ? null : refOf(target, 'target');
	const whole = flag(fullPage, 'FullPage');
	const format = type == null ? SHOT_TYPES.png : SHOT_TYPES[type];
	if (!format) {
		throw new Error(`Invalid type "${type}", png or jpeg`);
	}
	if (
		region != null &&
		(!Array.isArray(region) || region.length !== 4 || region.some((v) => typeof v !== 'number'))
	) {
		throw new Error('Region argument is not [x0, y0, x1, y1]');
	}
	if ([ref, whole || null, region].filter((v) => v != null).length > 1) {
		throw new Error('Give one of target, fullPage and region');
	}
	const zoom = scale == null ? 1 : number(scale, 'Scale');
	if (zoom < 1 || zoom > SCALE_MAX) {
		throw new Error(`Invalid scale "${scale}", from 1 to ${SCALE_MAX}`);
	}
	if (zoom > 1 && !ref && !region) {
		throw new Error('Scale magnifies a target or a region');
	}
	return session(async (s) => {
		const context = await s.context();
		const params = { context, origin: whole ? 'document' : 'viewport', format: { type: format } };
		if (format === SHOT_TYPES.jpeg) {
			params.format.quality = JPEG_QUALITY;
		}
		if (ref) {
			await s.page(context, 'locate', { ref, scroll: true });
			params.clip = { type: 'element', element: { sharedId: await s.element(context, ref) } };
		}
		if (region) {
			const [x0, y0, x1, y1] = region;
			params.clip = {
				type: 'box',
				x: Math.min(x0, x1),
				y: Math.min(y0, y1),
				width: Math.abs(x1 - x0),
				height: Math.abs(y1 - y0)
			};
		}
		const shot = await s.call('browsingContext.captureScreenshot', params);
		let bytes = Buffer.from(shot.data, 'base64');
		if (zoom > 1) {
			const { width } = await sharp(bytes).metadata();
			bytes = await sharp(bytes)
				.resize({ width: Math.round(width * zoom) })
				.toBuffer();
		}
		return imageResults(bytes, IMAGE_LIMITS);
	});
}

function waitFor({ text, textGone, time }) {
	const given = [text, textGone, time].filter((v) => v != null).length;
	if (given !== 1) {
		throw new Error('Give one of text, textGone and time');
	}
	if (time != null) {
		const seconds = number(time, 'Time');
		if (seconds <= 0 || seconds * MS > config.timeoutMs) {
			throw new Error(`Invalid time "${time}", seconds up to ${config.timeoutMs / MS}`);
		}
		return session(
			() => new Promise((resolve) => setTimeout(() => resolve(`Waited ${seconds} s`), seconds * MS))
		);
	}
	const needle = text == null ? textGone : text;
	return session(async (s) => {
		const context = await s.context();
		const deadline = Date.now() + config.timeoutMs;
		for (;;) {
			const shown = (await s.page(context, 'text')).includes(needle);
			if (shown === (text != null)) {
				return (text != null ? 'Text shown' : 'Text gone') + (await s.footer(context));
			}
			if (Date.now() > deadline) {
				throw new Error(`Still ${text != null ? 'absent' : 'shown'} after ${config.timeoutMs} ms`);
			}
			await new Promise((resolve) => setTimeout(resolve, config.pollMs));
		}
	});
}

function click({ target, button, doubleClick, modifiers }) {
	const ref = refOf(target, 'target');
	const which = button == null ? BUTTONS.left : BUTTONS[button];
	if (which === undefined) {
		throw new Error(`Invalid button "${button}", left, middle or right`);
	}
	const twice = flag(doubleClick, 'DoubleClick');
	const mods = modifiers == null ? [] : strings(modifiers, 'Modifiers');
	const bad = mods.find((m) => !MODIFIERS.includes(m));
	if (bad) {
		throw new Error(`Invalid modifier "${bad}", one of ${MODIFIERS.join(', ')}`);
	}
	return act(async (s, context) => {
		const keys = mods.map((m) => keyValue(m, s.state().platform));
		await clickAt(s, context, ref, twice ? 2 : 1, which, keys);
		return twice ? 'Double clicked' : 'Clicked';
	});
}

async function typeInto(s, context, ref, text, slowly) {
	await s.page(context, 'locate', { ref, scroll: true, enabled: true });
	if (slowly) {
		await s.page(context, 'fill', { ref, text: '' });
		await perform(s, context, typeActions(text));
	} else {
		await s.page(context, 'fill', { ref, text });
	}
}

function type({ target, text, slowly, submit }) {
	const ref = refOf(target, 'target');
	const slow = flag(slowly, 'Slowly');
	const enter = flag(submit, 'Submit');
	return act(async (s, context) => {
		await typeInto(s, context, ref, text, slow);
		if (enter) {
			await perform(s, context, keyActions([KEYS.Enter]));
		}
		return enter ? 'Typed and submitted' : 'Typed';
	});
}

function fillForm({ fields }) {
	if (!Array.isArray(fields) || !fields.length) {
		throw new Error('Fields argument is not a list of fields');
	}
	const checked = fields.map((field) => {
		if (typeof field !== 'object' || field === null || typeof field.value !== 'string') {
			throw new Error('Each field takes a target and a string value');
		}
		const kind = field.type == null ? FIELD_TYPES[0] : field.type;
		if (!FIELD_TYPES.includes(kind)) {
			throw new Error(`Invalid field type "${field.type}", one of ${FIELD_TYPES.join(', ')}`);
		}
		return { ref: refOf(field.target, 'target'), kind, value: field.value };
	});
	return act(async (s, context) => {
		for (const { ref, kind, value } of checked) {
			if (kind === 'checkbox' || kind === 'radio') {
				const want = value === 'true';
				if ((await s.page(context, 'state', { ref })) !== want) {
					await clickAt(s, context, ref);
				}
			} else if (kind === 'combobox') {
				await s.page(context, 'select', { ref, values: [value] });
			} else {
				await typeInto(s, context, ref, value, false);
			}
		}
		return `Filled ${checked.length} field${checked.length > 1 ? 's' : ''}`;
	});
}

function selectOption({ target, values }) {
	const ref = refOf(target, 'target');
	strings(values, 'Values');
	return act(async (s, context) => {
		await s.page(context, 'locate', { ref, scroll: true, enabled: true });
		const chosen = await s.page(context, 'select', { ref, values });
		return `Selected ${chosen}`;
	});
}

function pressKey({ key, seconds }) {
	const hold = seconds == null ? 0 : number(seconds, 'Seconds');
	if (hold < 0 || hold * MS > config.timeoutMs) {
		throw new Error(`Invalid seconds "${seconds}", up to ${config.timeoutMs / MS}`);
	}
	return act(async (s, context) => {
		const values = chord(key, s.state().platform);
		const actions = keyActions(values);
		if (hold) {
			actions[0].actions.splice(values.length, 0, {
				type: 'pause',
				duration: Math.round(hold * MS)
			});
		}
		await perform(s, context, actions);
		return 'Pressed';
	});
}

function hover({ target }) {
	const ref = refOf(target, 'target');
	return act(async (s, context) => {
		const point = await s.page(context, 'locate', { ref, scroll: true, hit: true });
		await perform(s, context, pointerActions([at(point)]));
		return 'Hovered';
	});
}

function drag({ from, to }) {
	const source = refOf(from, 'from');
	const dest = refOf(to, 'to');
	return act(async (s, context) => {
		const start = await s.page(context, 'locate', { ref: source, scroll: true, hit: true });
		const end = await s.page(context, 'locate', { ref: dest });
		await perform(
			s,
			context,
			pointerActions([
				at(start),
				{ type: 'pointerDown', button: BUTTONS.left },
				{ ...at(end), duration: config.dragMs },
				{ type: 'pointerUp', button: BUTTONS.left }
			])
		);
		return 'Dragged';
	});
}

function dragToOffset({ target, dx, dy }) {
	const ref = refOf(target, 'target');
	const ox = number(dx, 'Dx');
	const oy = number(dy, 'Dy');
	return act(async (s, context) => {
		const start = await s.page(context, 'locate', { ref, scroll: true, hit: true });
		const info = await s.page(context, 'info');
		const end = {
			x: Math.min(Math.max(start.x + ox, 0), info.width - 1),
			y: Math.min(Math.max(start.y + oy, 0), info.height - 1)
		};
		const moved = { x: Math.round(end.x - start.x), y: Math.round(end.y - start.y) };
		await perform(
			s,
			context,
			pointerActions([
				at(start),
				{ type: 'pointerDown', button: BUTTONS.left },
				{ ...at(end), duration: config.dragMs },
				{ type: 'pointerUp', button: BUTTONS.left }
			])
		);
		return moved.x === Math.round(ox) && moved.y === Math.round(oy)
			? 'Dragged'
			: `Dragged by ${moved.x}, ${moved.y}, kept in the viewport`;
	});
}

function handleDialog({ accept, promptText }) {
	if (typeof accept !== 'boolean') {
		throw new Error('Accept argument is not a boolean');
	}
	return act(async (s, context) => {
		const prompt = s.state().prompt;
		const params = { context: prompt ? prompt.context : context, accept };
		if (promptText != null) {
			params.userText = promptText;
		}
		try {
			await s.call('browsingContext.handleUserPrompt', params);
		} catch (error) {
			if (error.code === 'no such alert') {
				throw new Error('No dialog open');
			}
			throw error;
		}
		s.state().prompt = null;
		const what = prompt ? `${prompt.type} ${JSON.stringify(prompt.message)}` : 'dialog';
		return `${accept ? 'Accepted' : 'Dismissed'} the ${what}`;
	});
}

function consoleRead() {
	return session(async (s) => {
		const entries = s.state().console.splice(0);
		return entries.length ? entries.join('\n') : 'No console message since the last read';
	});
}

/**
 * A remote value as plain JSON
 * @param {object} v
 * @returns {*}
 */
function plain(v) {
	switch (v.type) {
		case 'undefined':
		case 'null':
			return null;
		case 'string':
		case 'number':
		case 'boolean':
		case 'bigint':
		case 'date':
			return v.value;
		case 'array':
		case 'set':
		case 'nodelist':
		case 'htmlcollection':
			return v.value ? v.value.map(plain) : `[${v.type}]`;
		case 'object':
		case 'map':
			return v.value
				? Object.fromEntries(
						v.value.map(([k, x]) => [typeof k === 'string' ? k : String(plain(k)), plain(x)])
					)
				: `[${v.type}]`;
		case 'regexp':
			return `/${v.value.pattern}/${v.value.flags || ''}`;
		case 'node':
			return `<${(v.value && v.value.localName) || 'node'}>`;
		default:
			return `[${v.type}]`;
	}
}

function evaluate({ expression }) {
	return session(async (s) => {
		const context = await s.context();
		const result = await s.call('script.evaluate', {
			expression,
			target: { context },
			awaitPromise: true,
			resultOwnership: 'none',
			serializationOptions: { maxObjectDepth: config.evalDepth, maxDomDepth: 0 }
		});
		if (result.type === 'exception') {
			throw new Error((result.exceptionDetails.text || 'Page error').replace(/^Error: /, ''));
		}
		const value = result.result;
		if (value.type === 'undefined') {
			return 'undefined';
		}
		return value.type === 'string' ? value.value : JSON.stringify(plain(value));
	});
}

const TOOLS_MAPPING = {
	browser_navigate: tool(navigate),
	browser_navigate_back: tool(navigateBack),
	browser_tabs: tool(tabs),
	browser_snapshot: tool(snapshot),
	browser_take_screenshot: tool(screenshot),
	browser_wait_for: tool(waitFor),
	browser_click: tool(click),
	browser_type: tool(type),
	browser_fill_form: tool(fillForm),
	browser_select_option: tool(selectOption),
	browser_press_key: tool(pressKey),
	browser_hover: tool(hover),
	browser_drag: tool(drag),
	browser_drag_to_offset: tool(dragToOffset),
	browser_handle_dialog: tool(handleDialog),
	browser_console: tool(consoleRead),
	browser_eval: tool(evaluate)
};

module.exports = {
	TOOLS_DEFINITIONS,
	TOOLS_MAPPING
};
