import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isPidAlive } from "../mcp-server.js";
import { bridgeServerEntry, bridgeServerName, readGlobalMcpConfig } from "../mcp-registration.js";
import { isValidAgyAgentName } from "../agents.js";
import { SYS_AGENT_PREFIX } from "../sysprompt-agent.js";
import { ACP_RECALL_HOOK_NAME } from "./recall-hook.js";

const HOOKS_FILE = "hooks.json";
const CREATED_AGENT_MARKER = ".recall-agent";
const RETIRED_AGENT_MARKER = ".recall-agent-retired";
const MAX_AGENT_MARKER_BYTES = 256;
const ACP_STAGED_HOME_NAME = /^acp-home-\d+-[a-zA-Z0-9]+$/;

function record(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must contain a JSON object`);
	return value as Record<string, unknown>;
}

function linkDirectory(source: string, target: string): void {
	fs.symlinkSync(source, target, "junction");
}

function resolveCarrierAgentMd(agent: string, geminiHome: string, explicitRoot?: string): string {
	const candidates = [
		explicitRoot,
		process.env.AGY_AGENTS_ROOT,
		path.join(geminiHome, "config", "agents"),
		path.join(os.homedir(), ".gemini", "config", "agents"),
	];
	for (const root of candidates) {
		if (!root) continue;
		const file = path.join(root, agent, "agent.md");
		try {
			if (fs.statSync(file).isFile()) return file;
		} catch {
			/* try next candidate */
		}
	}
	throw new Error(`ACP carrier agent "${agent}" not found`);
}

/** Staging root for isolated agy homes. The directory name predates the
 *  stream-json engine adopting homes; renaming it would strand existing
 *  installs' unswept dirs, so both engines stage under it. */
export function agyHomeStagingDir(): string {
	return path.join(os.homedir(), ".pi", "agent", "antigravity-bridge", "acp-homes");
}

export interface AgentMcpServerSpec {
	name: string;
	serverUrl: string;
	headers?: Record<string, string>;
}

function formatAgentMcpYaml(servers: readonly AgentMcpServerSpec[]): string {
	const lines: string[] = ["mcpServers:"];
	for (const server of servers) {
		lines.push(`  - name: ${JSON.stringify(server.name)}`);
		lines.push(`    serverUrl: ${JSON.stringify(server.serverUrl)}`);
		const headers = server.headers ? Object.entries(server.headers) : [];
		if (headers.length > 0) {
			lines.push("    headers:");
			for (const [k, v] of headers) {
				lines.push(`      ${JSON.stringify(k)}: ${JSON.stringify(v)}`);
			}
		}
	}
	return lines.join("\n");
}

function recallManifestMatches(file: string, content: string): boolean {
	try {
		return fs.readFileSync(file, "utf8") === content;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
		return false;
	}
}

/** AGY retains the resolved hook path with the conversation. Keep the static
 *  handler definition outside the per-spawn home that holds MCP credentials. */
function stageRecallManifest(parentDir: string, stagedHome: string, command: string): string {
	const content = JSON.stringify({
		[ACP_RECALL_HOOK_NAME]: {
			PreInvocation: [{ type: "command", command, timeout: 3 }],
		},
	});
	const hash = createHash("sha256").update(content).digest("hex");
	const dir = path.join(parentDir, "recall-hooks", hash);
	const file = path.join(dir, HOOKS_FILE);
	if (recallManifestMatches(file, content)) return file;

	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	// The per-spawn home provides a unique temporary file on the same volume.
	const pending = path.join(stagedHome, "recall-hooks.json.tmp");
	fs.writeFileSync(pending, content, { mode: 0o600 });
	try {
		fs.renameSync(pending, file);
	} catch (err) {
		// A concurrent process may have installed and opened the same manifest.
		if (!recallManifestMatches(file, content)) throw err;
		fs.rmSync(pending, { force: true });
	}
	return file;
}

function configurePrivateAgent(
	md: string,
	servers: readonly AgentMcpServerSpec[],
	recallHookPath?: string,
): string {
	if (servers.length === 0 && !recallHookPath) return md;
	const match = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/.exec(md);
	if (!match) throw new Error("ACP carrier agent.md is missing YAML frontmatter");
	let frontmatter = match[1];
	if (recallHookPath) {
		const emptyHooks = /^hooks: \[\]\r?$/m;
		if (!emptyHooks.test(frontmatter)) throw new Error("ACP carrier agent.md must declare an empty hooks list");
		// Explicit Markdown hook entries resolve relative to the agent.
		frontmatter = frontmatter.replace(emptyHooks, `hooks:\n  - ${JSON.stringify(recallHookPath)}`);
	}
	if (servers.length > 0) frontmatter += `\n${formatAgentMcpYaml(servers)}`;
	const suffix = match[2];
	const rest = md.slice(match[0].length);
	return `---\n${frontmatter}\n---${suffix}${rest}`;
}

export interface StageAgyHomeOptions {
	geminiHome?: string;
	parentDir?: string;
	/** Dir-name prefix: "acp-home" (ACP engine, default) or "agy-home"
	 *  (stream-json). The sweep accepts both. */
	prefix?: string;
	/** This session's bridge entry, written ENABLED straight into the staged
	 *  config (issue #14). Never ride the suppression marker here: the marker
	 *  hides bridges from an agy reading the GLOBAL config, and a private-home
	 *  agy never reads global - a marker-disabled own entry would break G9
	 *  silently inside our own home. Omit when the bridge is off. */
	ownBridge?: { pid: number; port: number; token: string; tokenHeader: string };
	/** Inherit foreign/global MCP entries from global mcp_config.json (default
	 *  true for stream-json; ACP sets false because session/new and
	 *  session/load plus the private agent frontmatter inject pi-bridge). */
	inheritGlobalMcp?: boolean;
	/** Generated carrier agent name for ACP restricted sessions. Copied into
	 *  <staged>/config/agents/<agent>/agent.md as a real directory (never
	 *  junctioned to global agents) so AGY_AGENTS_ROOT works and global
	 *  agents dirs are never mutated. */
	agent?: string;
	/** Explicit agent discovery root for tests; falls back to AGY_AGENTS_ROOT
	 *  then geminiHome/config/agents. */
	agentsRoot?: string;
	/** Session MCP server specs injected as `mcpServers` list-of-objects into
	 *  the PRIVATE copied carrier frontmatter so bridge access is part of the
	 *  custom Agent definition at creation time without writing secrets to the
	 *  global agent file. */
	agentMcpServers?: AgentMcpServerSpec[];
	/** Bridge-owned PreInvocation handler for the private carrier. */
	agentRecallHookCommand?: string;
}

/** Isolate a spawned agy from per-pid bridge entries in the global MCP
 *  config: the staged home carries the global servers (when inheritGlobalMcp
 *  is true) minus every pi-bridge-*, plus (optionally) this session's bridge
 *  entry. When an ACP carrier agent is set, stages only that agent into a
 *  real config/agents/<agent> directory without junctioning global agents. */
export function stageAgyHome(opts: StageAgyHomeOptions = {}): string {
	const geminiHome = opts.geminiHome ?? path.join(os.homedir(), ".gemini");
	const globalConfigDir = path.join(geminiHome, "config");
	const globalMcpPath = path.join(globalConfigDir, "mcp_config.json");
	const inheritGlobalMcp = opts.inheritGlobalMcp ?? true;
	let carrierMd: string | undefined;
	if (opts.agent !== undefined) {
		if (!isValidAgyAgentName(opts.agent)) {
			throw new Error(`Invalid ACP agent name: ${opts.agent}`);
		}
		carrierMd = resolveCarrierAgentMd(opts.agent, geminiHome, opts.agentsRoot);
	}

	let config: Record<string, unknown> = { mcpServers: {} };
	let filtered: Record<string, unknown> = {};
	if (inheritGlobalMcp) {
		try {
			// Tolerant of the CLI's 0-byte fresh-install file and a UTF-8 BOM;
			// only a missing file means "no config at all" (issue #11).
			config = record(readGlobalMcpConfig(globalMcpPath), globalMcpPath);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
				throw new Error(`Cannot isolate inherited MCP config ${globalMcpPath}: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
		const servers = record(config.mcpServers ?? {}, `${globalMcpPath} mcpServers`);
		filtered = Object.fromEntries(
			Object.entries(servers).filter(([name]) => !/^pi-bridge(?:-\d+)?$/.test(name)),
		);
	}
	if (opts.ownBridge) {
		filtered[bridgeServerName(opts.ownBridge.pid)] = bridgeServerEntry({ ...opts.ownBridge, disabled: false });
	}

	const parentDir = opts.parentDir ?? agyHomeStagingDir();
	const prefix = opts.prefix ?? "acp-home";
	fs.mkdirSync(parentDir, { recursive: true, mode: 0o700 });
	const staged = fs.mkdtempSync(path.join(parentDir, `${prefix}-${process.pid}-`));
	try {
		fs.mkdirSync(path.join(staged, "config"), { mode: 0o700 });
		fs.writeFileSync(path.join(staged, "config", "mcp_config.json"), JSON.stringify({ ...config, mcpServers: filtered }), { mode: 0o600 });

		const appData = path.join(geminiHome, "antigravity-cli");
		if (opts.agent) {
			// On a fresh install, create the durable target before agy sees
			// the staged home so its first conversation survives a recycle.
			fs.mkdirSync(appData, { recursive: true, mode: 0o700 });
		}
		if (fs.existsSync(appData)) linkDirectory(appData, path.join(staged, "antigravity-cli"));
		const instructions = path.join(geminiHome, "GEMINI.md");
		if (inheritGlobalMcp && fs.existsSync(instructions)) fs.copyFileSync(instructions, path.join(staged, "GEMINI.md"));
		const skipAgentsJunction = Boolean(opts.agent) || !inheritGlobalMcp;
		if (fs.existsSync(globalConfigDir)) {
			for (const entry of fs.readdirSync(globalConfigDir, { withFileTypes: true })) {
				if (entry.name === "mcp_config.json") continue;
				if (skipAgentsJunction && entry.name === "agents") continue;
				if (opts.agentRecallHookCommand && entry.name === HOOKS_FILE) continue;
				const source = path.join(globalConfigDir, entry.name);
				const target = path.join(staged, "config", entry.name);
				let stat: fs.Stats | fs.Dirent = entry;
				if (entry.isSymbolicLink()) {
					try {
						stat = fs.statSync(source);
					} catch (err) {
						if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
						throw err;
					}
				}
				if (stat.isDirectory()) linkDirectory(source, target);
				else if (stat.isFile()) fs.copyFileSync(source, target);
			}
		}
		if (opts.agent && carrierMd) {
			const targetDir = path.join(staged, "config", "agents", opts.agent);
			fs.mkdirSync(targetDir, { recursive: true, mode: 0o700 });
			const rawAgentMd = fs.readFileSync(carrierMd, "utf8");
			const recallManifest = opts.agentRecallHookCommand
				? stageRecallManifest(parentDir, staged, opts.agentRecallHookCommand)
				: undefined;
			const recallHookPath = recallManifest
				? path.relative(targetDir, recallManifest).split(path.sep).join("/")
				: undefined;
			const privateAgentMd = configurePrivateAgent(
				rawAgentMd,
				opts.agentMcpServers ?? [],
				recallHookPath,
			);
			fs.writeFileSync(path.join(targetDir, "agent.md"), privateAgentMd, { mode: 0o600 });
		}
		return staged;
	} catch (err) {
		fs.rmSync(staged, { recursive: true, force: true });
		throw err;
	}
}

/** Sweep staged homes whose owning pi process died. Accepts both engine
 *  prefixes; a home staged by the CURRENT process is skipped (it may be in
 *  use by a live driver - process-exit leftovers are the next start's
 *  problem). */
export function sweepStagedAgyHomes(baseDir: string = agyHomeStagingDir(), alive: (pid: number) => boolean = isPidAlive): void {
	let entries: string[];
	try {
		entries = fs.readdirSync(baseDir);
	} catch {
		return;
	}
	for (const name of entries) {
		const match = /^(?:acp|agy)-home-(\d+)-/.exec(name);
		if (!match) continue;
		const pid = Number(match[1]);
		if (pid === process.pid || alive(pid)) continue;
		removeStagedAgyHome(path.join(baseDir, name));
	}
}

/** Add or refresh this session's own bridge entry in an ALREADY-STAGED
 *  home (the bridge was enabled after the first spawn staged the home
 *  without one). Single-writer file (our pid owns the session), plain
 *  write is fine. */
export function writeOwnBridgeEntry(staged: string, entry: { pid: number; port: number; token: string; tokenHeader: string }): void {
	const cfgPath = path.join(staged, "config", "mcp_config.json");
	const cfg = record(readGlobalMcpConfig(cfgPath), cfgPath);
	const servers = record(cfg.mcpServers ?? {}, `${cfgPath} mcpServers`);
	servers[bridgeServerName(entry.pid)] = bridgeServerEntry({ ...entry, disabled: false });
	// Same-dir tmp + rename: agy watches config dirs, so a truncated
	// mid-write read must be impossible (issue #14 review round 3).
	const tmp = `${cfgPath}.tmp-${process.pid}`;
	fs.writeFileSync(tmp, JSON.stringify({ ...cfg, mcpServers: servers }), { mode: 0o600 });
	fs.renameSync(tmp, cfgPath);
}

function isRealDirectory(dir: string): boolean {
	const stat = fs.lstatSync(dir, { throwIfNoEntry: false });
	return stat?.isDirectory() === true && !stat.isSymbolicLink();
}

function isRecallCarrierName(agent: string): boolean {
	return agent.length < MAX_AGENT_MARKER_BYTES && agent.startsWith(SYS_AGENT_PREFIX) && isValidAgyAgentName(agent);
}

function readRecallAgentMarker(staged: string, marker: string): string | undefined {
	const file = path.join(staged, marker);
	try {
		const stat = fs.lstatSync(file, { throwIfNoEntry: false });
		if (!stat?.isFile() || stat.isSymbolicLink() || stat.size > MAX_AGENT_MARKER_BYTES) return;
		const content = fs.readFileSync(file, "utf8");
		if (!content.endsWith("\n")) return;
		const agent = content.slice(0, -1);
		return isRecallCarrierName(agent) ? agent : undefined;
	} catch (err) {
		// Another sweep may have renamed the marker between lstat and read.
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
	}
}

/** A newly created AGY conversation keeps its original carrier directory as
 *  a hook path anchor. Record only the generated basename, after session/new. */
export function markStagedAgyHomeSessionCreated(staged: string, agent: string): void {
	if (!ACP_STAGED_HOME_NAME.test(path.basename(staged)) || !isRecallCarrierName(agent)) {
		throw new Error("Cannot retain an invalid ACP carrier directory");
	}
	const config = path.join(staged, "config");
	const agents = path.join(config, "agents");
	if (!isRealDirectory(staged) || !isRealDirectory(config) || !isRealDirectory(agents) ||
		!isRealDirectory(path.join(agents, agent))) {
		throw new Error("Cannot retain a missing or linked ACP carrier directory");
	}
	const recorded = readRecallAgentMarker(staged, CREATED_AGENT_MARKER);
	if (recorded === agent) return;
	if (recorded !== undefined) throw new Error("ACP staged home already has a different carrier");
	const marker = path.join(staged, CREATED_AGENT_MARKER);
	const pending = `${marker}.tmp`;
	try {
		fs.writeFileSync(pending, `${agent}\n`, { mode: 0o600, flag: "wx" });
		fs.renameSync(pending, marker);
	} finally {
		fs.rmSync(pending, { force: true });
	}
}

function clearDirectoryExcept(dir: string, keep: readonly string[]): void {
	if (!isRealDirectory(dir)) {
		// rm unlinks a junction. Check each retained parent before reading
		// its children, so no cleanup traverses a link to shared state.
		fs.rmSync(dir, { recursive: true, force: true });
		fs.mkdirSync(dir, { mode: 0o700 });
		return;
	}
	for (const name of fs.readdirSync(dir)) {
		if (!keep.includes(name)) fs.rmSync(path.join(dir, name), { recursive: true, force: true });
	}
}

function retireRecallCarrier(staged: string, agent: string): void {
	const config = path.join(staged, "config");
	const agents = path.join(config, "agents");
	clearDirectoryExcept(staged, ["config", CREATED_AGENT_MARKER, RETIRED_AGENT_MARKER]);
	clearDirectoryExcept(config, ["agents"]);
	clearDirectoryExcept(agents, [agent]);
	clearDirectoryExcept(path.join(agents, agent), []);
	fs.renameSync(path.join(staged, CREATED_AGENT_MARKER), path.join(staged, RETIRED_AGENT_MARKER));
}

export function removeStagedAgyHome(staged: string): void {
	const base = path.basename(staged);
	if (!base.startsWith("acp-home-") && !base.startsWith("agy-home-")) return;
	try {
		if (!isRealDirectory(staged)) return;
		if (ACP_STAGED_HOME_NAME.test(base)) {
			const agent = readRecallAgentMarker(staged, CREATED_AGENT_MARKER);
			if (agent) {
				retireRecallCarrier(staged, agent);
				return;
			}
			// Read the creation marker first: a concurrent sweep may have
			// retired it, but never leaves a gap between the two markers.
			if (readRecallAgentMarker(staged, RETIRED_AGENT_MARKER)) return;
		}
		fs.rmSync(staged, { recursive: true, force: true });
	} catch {
		// Connection teardown is best-effort; startup sweeps crash leftovers.
	}
}
