import { createHash } from "node:crypto";
import type { SimpleStreamOptions, TranscriptContext, UserMessage } from "@earendil-works/pi-ai";
import type { ContextWithSystemEvent, ExtensionAPI } from "@earendil-works/pi-coding-agent";

type PiMessages = Readonly<ContextWithSystemEvent["messages"]>;

interface RecallReceipt {
	renderedHash: string;
	renderedLength: number;
}

interface RecallMessage {
	message: UserMessage;
	text: string;
	hasUserInput: boolean;
}

interface RequestScope {
	sessionId: string;
	signal: AbortSignal;
	receipt?: RecallReceipt;
}

export type ProjectHindsightRecall = (
	context: TranscriptContext,
	options?: SimpleStreamOptions,
) => { context: TranscriptContext; turnRecall?: string } | undefined;

function findAddedRecall(
	messages: PiMessages,
	branch: PiMessages,
	receipt: RecallReceipt,
): RecallMessage | undefined {
	const conversation = messages.filter((message) => message.role !== "system");
	const durableUsers = branch.filter((message) => message.role === "user");
	const remaining = durableUsers.slice();

	// Compare only receipt-matching occurrences. Other context hooks can edit
	// surrounding messages, including adding their own unrelated user entries.
	let extra: { message: UserMessage; text: string } | undefined;
	for (const message of conversation) {
		if (message.role !== "user" || typeof message.content !== "string") continue;
		const text = message.content;
		if (text.length !== receipt.renderedLength) continue;
		if (createHash("sha256").update(text).digest("hex") !== receipt.renderedHash) continue;

		const sameOccurrence = (original: UserMessage) =>
			original.timestamp === message.timestamp && original.content === text;
		const index = remaining.findIndex(sameOccurrence);
		if (index >= 0) {
			remaining.splice(index, 1);
			continue;
		}
		// An extra indistinguishable copy of a branch user has no unique owner.
		if (extra || durableUsers.some(sameOccurrence)) return;
		extra = { message, text };
	}
	if (!extra) return;
	const { message } = extra;
	const last = conversation.filter((item) => item !== message).at(-1);
	return { ...extra, hasUserInput: last?.role === "user" };
}

export function registerHindsightRecall(pi: ExtensionAPI): ProjectHindsightRecall {
	let scope: RequestScope | undefined;
	let projected = new WeakMap<UserMessage, RequestScope & { text: string; hasUserInput: boolean }>();
	const clearTurn = () => {
		scope = undefined;
		projected = new WeakMap();
	};

	// Pi emits one turn_start before each request. Hindsight emits its receipt
	// synchronously inside a plain context hook, whichever extension loaded first.
	pi.on("turn_start", (_event, ctx) => {
		clearTurn();
		const signal = ctx.signal;
		scope = signal && !signal.aborted ? { sessionId: ctx.sessionManager.getSessionId(), signal } : undefined;
	});
	pi.on("turn_end", clearTurn);
	pi.on("session_shutdown", clearTurn);
	pi.events.on("hindsight:retrieval", (data) => {
		if (!scope || scope.signal.aborted || typeof data !== "object" || data === null) return;
		const event = data as Record<string, unknown>;
		if (event.phase !== "injection" || event.mode !== "automatic" || event.sessionId !== scope.sessionId) return;

		const { contextId, renderedHash, renderedLength } = event;
		scope.receipt = undefined;
		if (
			event.status === "success" && event.injected === true &&
			typeof contextId === "string" && contextId.length > 0 &&
			typeof renderedHash === "string" && /^[a-f0-9]{64}$/.test(renderedHash) &&
			typeof renderedLength === "number" && Number.isSafeInteger(renderedLength) && renderedLength > 0
		) {
			scope.receipt = { renderedHash, renderedLength };
		}
	});
	pi.on("context_with_system", (event, ctx) => {
		const request = scope;
		scope = undefined;
		if (!request?.receipt || request.signal.aborted || request.signal !== ctx.signal) return;
		if (request.sessionId !== ctx.sessionManager.getSessionId()) return;

		const branch = ctx.sessionManager.buildSessionProjection().messages;
		const recall = findAddedRecall(event.messages, branch, request.receipt);
		if (!recall) return;
		// Pi preserves ordinary user objects when converting to provider messages.
		// This handoff leaves the context seen by other providers untouched.
		projected.set(recall.message, {
			sessionId: request.sessionId,
			signal: request.signal,
			text: recall.text,
			hasUserInput: recall.hasUserInput,
		});
	});

	return (context, options) => {
		if (!options?.sessionId || !options.signal || options.signal.aborted) return;
		for (const message of context.messages) {
			if (message.role !== "user") continue;
			const recall = projected.get(message);
			if (!recall || recall.sessionId !== options.sessionId || recall.signal !== options.signal) continue;
			if (recall.text !== message.content) continue;

			const messages = context.messages.filter((item) => item !== message);
			// The same projected request can be retried after a predispatch failure.
			const turnRecall = recall.hasUserInput ? recall.text : undefined;
			return { context: { ...context, messages }, turnRecall };
		}
	};
}
