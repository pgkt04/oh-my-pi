import { describe, expect, it } from "bun:test";
import {
	encodeTspHelloQuery,
	encodeTspMessage,
	encodeTspRmuxReadyQuery,
	parseTspMessage,
	splitTspMessage,
	TspReader,
} from "@oh-my-pi/pi-tui/native/encode";
import type { TspEvent } from "@oh-my-pi/pi-wire";

const encoder = new TextEncoder();

/** Split a byte stream of APC messages into complete `ESC _ … ESC \` strings. */
function messages(stream: string): string[] {
	return stream
		.split("\x1b\\")
		.filter(Boolean)
		.map(part => `${part}\x1b\\`);
}

describe("TSP framing", () => {
	it("advertises prompt submission and the rmux renderer-switch extension without an initial epoch", () => {
		const raw = splitTspMessage(encodeTspHelloQuery("test"))!;
		expect(JSON.parse(raw.body)).toEqual({
			q: "hello",
			v: [1],
			app: "omp",
			features: ["edit", "undo", "send", "rmux-reprobe"],
			ver: "test",
		});
	});

	it("pins a runtime rmux probe to its requested epoch and encodes the first-paint barrier", () => {
		const query = splitTspMessage(encodeTspHelloQuery(undefined, 18))!;
		expect(query.verb).toBe("q");
		expect(JSON.parse(query.body)).toEqual({
			q: "hello",
			v: [1],
			app: "omp",
			features: ["edit", "undo", "send", "rmux-reprobe"],
			rmuxEpoch: 18,
		});
		for (const renderer of ["ansi", "native"] as const) {
			expect(encodeTspRmuxReadyQuery(18, renderer)).toBe(
				`\x1b_tsp;q;{"q":"rmux-ready","epoch":18,"renderer":"${renderer}"}\x1b\\`,
			);
		}
	});

	it("decodes broker credits and ANSI probe epochs without treating a private reply as hello", () => {
		const reply = {
			r: "hello",
			v: 1,
			term: "rmux",
			kinds: ["col", "editor"],
			rmux: { broker: 1, epoch: 18, strictCredits: true, future: "kept" },
		} as const;
		expect(parseTspMessage(encodeTspMessage("r", JSON.stringify(reply)))).toEqual({ verb: "r", reply });
		for (const probe of [
			{ r: "rmux-probe", epoch: 18, native: false },
			{ r: "rmux-probe", epoch: 17, native: false, accepted: false },
		] as const) {
			expect(parseTspMessage(encodeTspMessage("r", JSON.stringify(probe)))).toEqual({ verb: "r", reply: probe });
		}
	});

	it("decodes view changes without a surface and ready rejection without committing a stale epoch", () => {
		for (const reason of ["viewers", "capabilities", "geometry", "ui"] as const) {
			const event = { ev: "rmux-view", epoch: 18, reason } as const;
			const reader = new TspReader();
			const decoded = messages(encodeTspMessage("e", JSON.stringify(event), undefined, 8)).map(message =>
				reader.feed(message),
			);
			expect(decoded.slice(0, -1)).toEqual(Array(decoded.length - 1).fill(null));
			expect(decoded.at(-1)).toEqual({ verb: "e", event });
		}
		for (const accepted of [true, false]) {
			const reply = { r: "rmux-ready", epoch: 18, accepted } as const;
			expect(parseTspMessage(encodeTspMessage("r", JSON.stringify(reply)))).toEqual({ verb: "r", reply });
		}
	});

	it("rejects malformed broker identities, epochs, and private transition controls", () => {
		const hello = { r: "hello", v: 1, term: "rmux", kinds: ["col"] };
		for (const rmux of [
			null,
			{},
			{ broker: 2, epoch: 18, strictCredits: true },
			{ broker: 1, epoch: 18, strictCredits: "true" },
			{ broker: 1, strictCredits: true },
		]) {
			expect(parseTspMessage(encodeTspMessage("r", JSON.stringify({ ...hello, rmux })))).toBeNull();
		}
		for (const epoch of [undefined, "18", -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
			for (const [verb, body] of [
				["r", { ...hello, rmux: { broker: 1, epoch, strictCredits: true } }],
				["r", { r: "rmux-probe", epoch, native: false }],
				["r", { r: "rmux-ready", epoch, accepted: true }],
				["e", { ev: "rmux-view", epoch, reason: "viewers" }],
			] as const) {
				expect(parseTspMessage(encodeTspMessage(verb, JSON.stringify(body)))).toBeNull();
			}
		}
		for (const [verb, body] of [
			["r", { r: "rmux-probe", epoch: 18, native: "false" }],
			["r", { r: "rmux-probe", epoch: 18, native: false, accepted: "false" }],
			["r", { r: "rmux-ready", epoch: 18 }],
			["r", { r: "rmux-ready", epoch: 18, accepted: "true" }],
			["e", { ev: "rmux-view", epoch: 18, reason: "other" }],
		] as const) {
			expect(parseTspMessage(encodeTspMessage(verb, JSON.stringify(body)))).toBeNull();
		}
	});

	it("reassembles a multiline send without altering its supplied text", () => {
		const reader = new TspReader();
		const event: Extract<TspEvent, { ev: "send" }> = {
			ev: "send",
			sf: "s:1",
			id: "a.line/input",
			text: "first\n€漢字🙂\nlast",
		};
		const decoded = messages(encodeTspMessage("e", JSON.stringify(event), undefined, 8)).map(message =>
			reader.feed(message),
		);
		expect(decoded.slice(0, -1).every(message => message === null)).toBe(true);
		expect(decoded.at(-1)).toEqual({ verb: "e", event });
	});

	it("rejects send events without a surface, target or string prompt", () => {
		const valid: Extract<TspEvent, { ev: "send" }> = { ev: "send", sf: "s:1", id: "a.line/input", text: "prompt" };
		for (const event of [
			{ ...valid, sf: undefined },
			{ ...valid, sf: null },
			{ ...valid, sf: 1 },
			{ ...valid, sf: "" },
			{ ...valid, id: undefined },
			{ ...valid, id: null },
			{ ...valid, id: 1 },
			{ ...valid, id: "" },
			{ ...valid, text: undefined },
			{ ...valid, text: null },
			{ ...valid, text: 1 },
			{ ...valid, text: ["prompt"] },
		]) {
			expect(parseTspMessage(encodeTspMessage("e", JSON.stringify(event)))).toBeNull();
		}
		expect(parseTspMessage(encodeTspMessage("e", JSON.stringify({ ...valid, text: "" })))).toEqual({
			verb: "e",
			event: { ...valid, text: "" },
		});
	});

	it("chunks a body over the APC limit and reassembles it byte-exact, never splitting a code point", () => {
		const body = JSON.stringify({ text: 'ab€漢字🙂🙃 é\u001b"quote" '.repeat(9) });
		const limit = 23;
		const chunks = messages(encodeTspMessage("f", body, undefined, limit)).map(message => splitTspMessage(message)!);

		expect(chunks.length).toBeGreaterThan(1);
		const ids = new Set(chunks.map(chunk => chunk.params.c));
		expect(ids.size).toBe(1);
		expect(chunks.map(chunk => chunk.params.m)).toEqual([...Array(chunks.length - 1).fill("1"), undefined]);
		for (const chunk of chunks) {
			expect(chunk.verb).toBe("f");
			expect(encoder.encode(chunk.body).length).toBeLessThanOrEqual(limit);
			// Each chunk is whole UTF-8: no lone surrogates survive encoding.
			expect(chunk.body.isWellFormed()).toBe(true);
			expect(chunk.body).not.toContain("\x1b");
		}
		const joined = Buffer.concat(chunks.map(chunk => encoder.encode(chunk.body)));
		expect(joined.equals(Buffer.from(encoder.encode(body)))).toBe(true);
	});

	it("keeps parameter-shaped JSON text at every chunk boundary instead of consuming it as transport metadata", () => {
		// c/m-shaped text must not replace the real chunk id/continuation bit.
		// Empty values and printable punctuation exercise the full param grammar;
		// Unicode, spaces and semicolons provide distinct safe split boundaries.
		const body = JSON.stringify({
			text: "x=1;y c=other;tail m=1;next _key-9=;end digits9=:-_+<>;last €漢🙂\u009c \u001b".repeat(3),
		});
		for (let limit = 4; limit <= 64; limit++) {
			const chunks = messages(encodeTspMessage("f", body, undefined, limit)).map(message =>
				splitTspMessage(message)!,
			);
			const chunkId = chunks[0]!.params.c;
			for (let i = 0; i < chunks.length; i++) {
				const chunk = chunks[i]!;
				expect(chunk.params).toEqual({ c: chunkId, ...(i < chunks.length - 1 ? { m: "1" } : {}) });
				expect(encoder.encode(chunk.body).length).toBeLessThanOrEqual(limit);
				expect(chunk.body.isWellFormed()).toBe(true);
			}
			expect(chunks.map(chunk => chunk.body).join("")).toBe(body);
		}
	});

	it("reassembles parameter-shaped editing text without losing content or the continuation marker", () => {
		const event: Extract<TspEvent, { ev: "send" }> = {
			ev: "send",
			sf: "s:1",
			id: "composer",
			text: "x=1;y c=other;tail m=1;next €漢🙂",
		};
		const body = JSON.stringify(event);
		for (let limit = 4; limit <= 32; limit++) {
			const reader = new TspReader();
			const decoded = messages(encodeTspMessage("e", body, undefined, limit)).map(message => reader.feed(message));
			expect(decoded.slice(0, -1)).toEqual(Array(decoded.length - 1).fill(null));
			expect(decoded.at(-1)).toEqual({ verb: "e", event });
		}
	});

	it("keeps blob id and MIME parameters while splitting base64 padding at the APC limit", () => {
		const bytes = Buffer.from("€漢🙂 blob bytes");
		const body = bytes.toString("base64");
		const params = { id: "a".repeat(64), mime: "image/png" };
		const chunks = messages(encodeTspMessage("b", body, params, 5)).map(message => splitTspMessage(message)!);
		expect(chunks[0]!.params).toMatchObject(params);
		for (const chunk of chunks) expect(encoder.encode(chunk.body).length).toBeLessThanOrEqual(5);
		expect(Buffer.from(chunks.map(chunk => chunk.body).join(""), "base64")).toEqual(bytes);
	});

	it("sends a body at the limit as a single unchunked message", () => {
		const body = "x".repeat(40);
		const stream = encodeTspMessage("f", body, undefined, 40);
		expect(stream).toBe(`\x1b_tsp;f;${body}\x1b\\`);
	});

	it("reassembles chunked terminal events and tolerates unknown fields", () => {
		const reader = new TspReader();
		const event = JSON.stringify({ ev: "toggle", sf: "s:1", id: "a.b", collapsed: false, future: { x: 1 } });
		const decoded = messages(encodeTspMessage("e", event, undefined, 8)).map(message => reader.feed(message));
		expect(decoded.slice(0, -1).every(message => message === null)).toBe(true);
		// Unknown fields survive decoding untouched.
		const last: unknown = decoded.at(-1);
		expect(last).toEqual({
			verb: "e",
			event: { ev: "toggle", sf: "s:1", id: "a.b", collapsed: false, future: { x: 1 } },
		});
	});

	it("decodes prefs change events whatever their value", () => {
		for (const value of [true, 50, "branch", ["c", "a"], null]) {
			const event = { ev: "change", sf: "s:1", id: "pf", item: "task.isolation.merge", value };
			const decoded: unknown = parseTspMessage(`\x1b_tsp;e;${JSON.stringify(event)}\x1b\\`);
			expect(decoded).toEqual({ verb: "e", event });
		}
		expect(parseTspMessage('\x1b_tsp;e;{"ev":"change","sf":"s:1","id":"pf"}\x1b\\')).toBeNull();
	});

	it("rejects malformed replies and events", () => {
		expect(parseTspMessage('\x1b_tsp;r;{"r":"hello","v":1,"term":"tern"}\x1b\\')).toBeNull();
		expect(parseTspMessage('\x1b_tsp;e;{"ev":"ack"}\x1b\\')).toBeNull();
		expect(parseTspMessage("\x1b_tsp;e;{not json\x1b\\")).toBeNull();
		expect(parseTspMessage('\x1b_tsp;f;{"sf":"s:1","s":1,"ops":[]}\x1b\\')).toBeNull();
		expect(parseTspMessage('\x1b_25a1;e;{"ev":"ack","s":1}\x1b\\')).toBeNull();
		const tolerant: unknown = parseTspMessage(
			'\x1b_tsp;r;{"r":"hello","v":1,"term":"tern","kinds":["col"],"x":2}\x1b\\',
		);
		expect(tolerant).toEqual({
			verb: "r",
			reply: { r: "hello", v: 1, term: "tern", kinds: ["col"], x: 2 },
		});
	});
});
