import { afterEach, expect, it } from "bun:test";
import { Editor } from "@oh-my-pi/pi-tui/components/editor";
import { Text } from "@oh-my-pi/pi-tui/components/text";
import { defaultEditorTheme } from "../test-themes";
import { TspHarness } from "./tsp-harness";

let harness: TspHarness | undefined;
afterEach(() => {
	harness?.stop();
	harness = undefined;
});

it("switches unchanged-size native/ANSI views without losing transcript, draft, dialog or undo", async () => {
	const editor = new Editor(defaultEditorTheme);
	editor.setText("draft");
	harness = await TspHarness.start(tui => {
		tui.addChild(new Text("retained transcript"));
		tui.addChild(editor);
	});
	const h = harness;
	const dialog = new Text("live dialog");
	h.tui.showOverlay(dialog);
	await h.render();
	editor.applyHostEdit({ from: 5, to: 5, text: "!", cursor: 6, len: 5 });
	const old = h.terminal.surface;
	h.terminal.brokerView(2);
	h.terminal.answerProbe({ rmux: { broker: 1, epoch: 1, strictCredits: true } });
	h.flush();
	expect(h.tui.nativeRendering).toBe(false);
	expect(h.terminal.rowBytes).toContain("retained transcript");
	expect(h.terminal.rowBytes).toContain("live dialog");
	expect(editor.getText()).toBe("draft!");
	h.terminal.brokerReady(1);
	h.terminal.brokerView(3);
	expect(h.terminal.tspProbePending).toBe(false);
	h.terminal.brokerReady(2, false);
	expect(h.terminal.tspProbePending).toBe(true);
	h.terminal.answerProbe({ rmux: { broker: 1, epoch: 3, strictCredits: true } });
	h.flush();
	expect(h.tui.nativeRendering).toBe(true);
	expect(h.terminal.surface).not.toBe(old);
	expect(h.find(node => node.k === "editor")?.p).toMatchObject({ text: "draft!" });
	expect(
		h.terminal.log.some(message => message.verb === "q" && JSON.stringify(message.body).includes('"epoch":3')),
	).toBe(true);
	h.terminal.brokerReady(3);
	editor.handleInput("\x1b[45;5u");
	expect(editor.getText()).toBe("draft");
	expect(h.errors).toEqual([]);
});
