import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Inbound attachments: turning "a file the user sent in chat" into "a path the agent can open".
 *
 * Every chat transport hands us something different — QQ gives a `file_id` and requires a second
 * call to find the bytes, Feishu gives a `file_key` tied to a message id — so the download step has
 * to stay provider-specific. What is shared, and what this module owns, is the part that must not
 * be re-decided per provider:
 *
 * 1. **Where it lands**: `<workspace>/inbox/`, never inside the project the agent might edit.
 * 2. **What it is called**: a sanitised basename. A file called `../../etc/passwd` must not escape.
 * 3. **How big it may be**: a chat upload is not a dataset; past the cap we refuse instead of
 *    filling the server's disk (this box has 40 GB and already swaps).
 * 4. **How the model learns about it**: a line it can act on, because an attachment that the prompt
 *    never mentions is the same as a dropped message.
 */

export type InboundAttachment = {
  kind: "file" | "image";
  /** Provider handle; QQ calls it file_id, Feishu calls it file_key. */
  id?: string;
  url?: string;
  name?: string;
  /** Feishu needs the message id to fetch the resource. */
  messageId?: string;
};

export const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;

/** Reduce a provider-supplied name to a safe basename. Never returns an empty string. */
export function sanitizeName(name: string | undefined, fallback: string): string {
  const base = String(name ?? "")
    .replace(/\\/g, "/")
    .split("/")
    .pop()
    ?? "";
  const cleaned = base
    .replace(/[\u0000-\u001f<>:"|?*]/g, "")
    .replace(/^\.+/, "")
    .trim();
  return cleaned.length > 0 ? cleaned.slice(0, 120) : fallback;
}

/** Files land here; created on demand so a first upload does not need a manual mkdir. */
export function inboxDir(workspace: string): string {
  const dir = path.join(workspace, "inbox");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export type SaveResult = { ok: true; path: string; bytes: number } | { ok: false; reason: string };

/**
 * Persist one attachment.
 *
 * `workspace` is the host-visible root; the returned path is what the agent should be told, which is
 * why the caller passes the *container* path separately when they differ.
 */
export function saveAttachment(input: {
  workspace: string;
  displayAs?: string;
  name?: string;
  kind: "file" | "image";
  buffer: Buffer;
  maxBytes?: number;
}): SaveResult {
  const maxBytes = input.maxBytes ?? DEFAULT_MAX_BYTES;
  if (input.buffer.length === 0) return { ok: false, reason: "文件内容为空" };
  if (input.buffer.length > maxBytes) {
    return { ok: false, reason: `文件超过上限（${Math.round(maxBytes / 1024 / 1024)} MB）` };
  }
  const fallback = input.kind === "image" ? "image.bin" : "file.bin";
  const safe = sanitizeName(input.name, fallback);
  const dir = inboxDir(input.workspace);
  // Same name twice in one day must not overwrite: a second upload is usually a correction.
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  let target = path.join(dir, `${stamp}-${safe}`);
  let index = 1;
  while (existsSync(target)) {
    index += 1;
    target = path.join(dir, `${stamp}-${index}-${safe}`);
  }
  writeFileSync(target, input.buffer);
  const shown = input.displayAs ? `${input.displayAs.replace(/\\$/, "")}/${path.basename(target)}` : target;
  return { ok: true, path: shown, bytes: input.buffer.length };
}

/**
 * The line prepended to the user's text.
 *
 * Written as an instruction rather than a fact ("附件已保存到…") because the failure mode we saw in
 * production was silence: the model had no idea a file had been sent, so it answered as if the
 * question came out of nowhere.
 */
export function attachmentNote(saved: Array<{ path: string; kind: "file" | "image" }>, failed: string[] = []): string {
  const lines = saved.map((item) => `[${item.kind === "image" ? "图片" : "文件"}] ${item.path}`);
  if (failed.length > 0) lines.push(`[附件失败] ${failed.join("；")}`);
  if (lines.length === 0) return "";
  return `${lines.join("\n")}\n（以上附件已保存到工作区，直接用 read/bash 打开；PDF 需要先转文本。）`;
}
