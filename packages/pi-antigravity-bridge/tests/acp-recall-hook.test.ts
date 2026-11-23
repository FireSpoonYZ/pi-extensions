import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { MAX_FRAME_BYTES } from "../src/frame-guard.js";
import { createAcpRecallHook, type AcpRecallHook } from "../src/acp/recall-hook.js";

const client = fileURLToPath(new URL("../src/acp/recall-hook-client.cjs", import.meta.url));

function invoke(hook: AcpRecallHook, conversationId: string, extraEnv: Record<string, string> = {}) {
	return new Promise<{ injectSteps?: { ephemeralMessage: string }[] }>((resolve, reject) => {
		const child = execFile(process.execPath, [client], {
			env: { ...process.env, ...hook.env, ...extraEnv },
			windowsHide: true,
		}, (error, stdout) => {
			if (error) reject(error);
			else resolve(JSON.parse(stdout));
		});
		child.stdin!.end(JSON.stringify({ conversationId }));
	});
}

test("the private Code Mode policy allows both dispatch forms only for pi-bridge codemode", () => {
	const decision = (toolCall: object) => JSON.parse(execFileSync(
		process.execPath, [client, "--codemode-only"],
		{ input: JSON.stringify({ hookEventName: "PreToolUse", toolCall }), encoding: "utf8" },
	)).decision;
	const dispatch = { name: "call_mcp_tool", args: { ServerName: "pi-bridge", ToolName: "codemode" } };
	assert.equal(decision(dispatch), "allow");
	const direct = { name: "mcp_pi-bridge_codemode" };
	assert.equal(decision({ ...direct, args: { code: "text(1)" } }), "allow");
	assert.equal(decision({ ...direct, args: { pollCallId: "call-id" } }), "allow");
	assert.equal(decision({ ...dispatch, args: { ...dispatch.args, ToolName: "bridge_poll_result" } }), "deny");
	assert.equal(decision({ ...dispatch, args: { ...dispatch.args, ServerName: "other-mcp" } }), "deny");
	assert.equal(decision({ name: "mcp_other-mcp_codemode" }), "deny");
	assert.equal(decision({ name: "mcp_pi-bridge_bridge_poll_result" }), "deny");
	assert.equal(decision({ name: "codemode" }), "deny");
	assert.equal(decision({ name: "list_resources" }), "deny");
	assert.equal(decision({ name: "manage_task" }), "deny");
});

test("the shipped AGY hook exposes only the active conversation and the current turn", async () => {
	const hook = await createAcpRecallHook();
	try {
		const first = "完整记忆 ".repeat(3_000);
		const finishFirst = hook.bind("session", first);
		const steps = (await invoke(hook, "session")).injectSteps;
		assert.equal(steps?.length, 1);
		assert.ok(steps[0].ephemeralMessage.endsWith(JSON.stringify(first)));
		assert.deepEqual(await invoke(hook, "elsewhere"), {});
		assert.deepEqual(await invoke(hook, "session", { PI_AGY_RECALL_KEY: "0".repeat(64) }), {});

		const finishSecond = hook.bind("session", "R2");
		finishFirst();
		const second = await invoke(hook, "session");
		assert.ok(second.injectSteps?.[0].ephemeralMessage.endsWith('"R2"'));
		finishSecond();
		assert.deepEqual(await invoke(hook, "session"), {});
		hook.bind("session", "R3");
		hook.bind("session", undefined);
		assert.deepEqual(await invoke(hook, "session"), {});
	} finally {
		hook.close();
	}
	assert.deepEqual(await invoke(hook, "session"), {});
});

test("an oversized new recall clears the previous one and reports only the byte counts", async () => {
	const sizes: number[][] = [];
	const hook = await createAcpRecallHook({ onOversize: (actual, limit) => sizes.push([actual, limit]) });
	try {
		hook.bind("session", "first memory");
		hook.bind("session", "x".repeat(MAX_FRAME_BYTES + 1));
		assert.deepEqual(sizes, [[MAX_FRAME_BYTES + 1, MAX_FRAME_BYTES]]);
		assert.deepEqual(await invoke(hook, "session"), {});
	} finally {
		hook.close();
	}
});
