import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { normalizeContext, type UserMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { registerHindsightRecall } from "../src/hindsight-recall.js";

function user(content: string, timestamp: number): UserMessage {
	return { role: "user", content, timestamp };
}

function fixture(durable: UserMessage[]) {
	const lifecycle = new EventEmitter();
	const events = new EventEmitter();
	const project = registerHindsightRecall({
		on: lifecycle.on.bind(lifecycle),
		events,
	} as unknown as ExtensionAPI);
	const controller = new AbortController();
	const options = { sessionId: "pi-conversation", signal: controller.signal };
	const ctx = {
		signal: controller.signal,
		sessionManager: {
			getSessionId: () => options.sessionId,
			buildSessionProjection: () => ({ messages: durable }),
		},
	};
	function receipt(text: string, fields: Record<string, unknown> = {}) {
		events.emit("hindsight:retrieval", {
			phase: "injection", mode: "automatic", sessionId: options.sessionId,
			contextId: "pi-projection", status: "success", injected: true,
			renderedHash: createHash("sha256").update(text).digest("hex"), renderedLength: text.length,
			...fields,
		});
	}
	function start() { lifecycle.emit("turn_start", {}, ctx); }
	function render(messages: UserMessage[]) {
		lifecycle.emit("context_with_system", { messages }, ctx);
		return normalizeContext({ messages });
	}
	start();
	return { project, options, controller, receipt, start, render, lifecycle };
}

for (const position of ["prepend", "append"] as const) {
	test(position + " recall survives other context edits and leaves an identical pasted message in history", () => {
		const pasted = user("<hindsight-memory>same text</hindsight-memory>", 1);
		const question = user("What's new?", 2);
		const added = user(String(pasted.content), 3);
		const unrelated = user("Other extension's context", 4);
		const f = fixture([pasted, question]);
		f.receipt(String(added.content));
		const messages = position === "prepend" ? [added, unrelated, pasted, question] : [unrelated, pasted, added, question];
		const context = f.render(messages);
		for (let attempt = 0; attempt < 2; attempt++) {
			const projected = f.project(context, f.options);
			assert.equal(projected?.turnRecall, added.content);
			assert.deepEqual(projected?.context.messages, [unrelated, pasted, question]);
		}
		assert.deepEqual(context.messages, messages);
		assert.equal(f.project(context, { ...f.options, sessionId: "other" }), undefined);
		assert.equal(f.project(context, { ...f.options, signal: new AbortController().signal }), undefined);
		f.lifecycle.emit("turn_end");
		assert.equal(f.project(context, f.options), undefined);
		f.start();
		f.receipt("", { status: "empty", injected: false });
		assert.equal(f.project(f.render(messages), f.options), undefined);
	});
}

test("preserves ordinary users when recall is manual, unconfirmed, or indistinguishable", () => {
	const pasted = user("A genuine user message", 1);
	for (const fields of [{ mode: "manual" }, { renderedHash: "0".repeat(64) }, { sessionId: "other" }]) {
		const f = fixture([pasted]);
		f.receipt(String(pasted.content), fields);
		const context = f.render([user(String(pasted.content), 2), pasted]);
		assert.equal(f.project(context, f.options), undefined);
	}
	const f = fixture([pasted]);
	f.receipt(String(pasted.content));
	assert.equal(f.project(f.render([{ ...pasted }, pasted]), f.options), undefined);
});

test("an aborted turn cannot deliver a captured recall", () => {
	const question = user("Question", 1), recall = user("Recall", 2);
	const f = fixture([question]);
	f.receipt("Recall");
	const context = f.render([recall, question]);
	f.controller.abort();
	assert.equal(f.project(context, f.options), undefined);
});
