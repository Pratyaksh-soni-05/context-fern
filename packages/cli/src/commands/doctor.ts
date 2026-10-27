// `fern doctor` — checks what this PR actually knows about for certain:
// daemon health and the model cache. The Claude Code plugin-install
// check is deliberately a placeholder: PR 2's own first task is
// verifying Claude Code's real plugin-discovery mechanism against
// official docs, and guessing at an unverified config location now
// risks a misleading health check. Ollama is only checked when the
// project's config.toml actually has a [stage2] section — read raw
// here (not through loadFernConfig, which doesn't recognize that
// section yet since nothing routes on it in this PR).

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { CLI_NAME, CONFIG_DIR } from "@context-fern/core";
import { readDaemonInfo } from "@context-fern/daemon";
import { modelCacheDir } from "@context-fern/embed";
import { isAlive } from "../daemon-client";

async function dirHasFiles(path: string): Promise<boolean> {
  try {
    const entries = await readdir(path);
    return entries.length > 0;
  } catch {
    return false;
  }
}

async function readStage2OllamaUrl(): Promise<string | null> {
  try {
    const path = join(process.cwd(), CONFIG_DIR, "config.toml");
    const text = await Bun.file(path).text();
    const parsed = Bun.TOML.parse(text) as { stage2?: { ollama_url?: string } };
    if (!parsed.stage2) return null;
    return parsed.stage2.ollama_url ?? "http://localhost:11434";
  } catch {
    return null;
  }
}

async function pingOllama(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/api/tags`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function runDoctor(): Promise<void> {
  const lines: string[] = [];

  const info = await readDaemonInfo();
  const daemonOk = info ? await isAlive(info) : false;
  lines.push(
    `daemon: ${daemonOk ? "ok" : `not running — run "${CLI_NAME} daemon start"`}`,
  );

  const cacheOk = await dirHasFiles(modelCacheDir());
  lines.push(
    `model cache: ${cacheOk ? "ok" : "empty (will download on first use)"}`,
  );

  const ollamaUrl = await readStage2OllamaUrl();
  if (!ollamaUrl) {
    lines.push("stage2 (Ollama): not configured, skipping");
  } else {
    const ok = await pingOllama(ollamaUrl);
    lines.push(`stage2 (Ollama at ${ollamaUrl}): ${ok ? "ok" : "unreachable"}`);
  }

  lines.push(
    "plugin: check not available yet — coming in the Claude Code plugin PR",
  );

  console.log(lines.map((l) => `${CLI_NAME} ▸ ${l}`).join("\n"));
}
