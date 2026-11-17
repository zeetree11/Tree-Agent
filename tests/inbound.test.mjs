import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { attachmentNote, saveAttachment, sanitizeName } from "../src/inbound.ts";

let pass = 0;
let fail = 0;
function check(name, ok, detail = "") {
  if (ok) {
    pass += 1;
    console.log(`PASS ${name}`);
  } else {
    fail += 1;
    console.log(`FAIL ${name} ${detail}`);
  }
}

const dir = mkdtempSync(path.join(tmpdir(), "pi-inbound-"));
const buffer = Buffer.from("%PDF-1.4 fake", "utf8");

// 1) 文件名清洗：路径穿越必须被削平
{
  check("strips traversal", sanitizeName("../../etc/passwd", "x") === "passwd", sanitizeName("../../etc/passwd", "x"));
  check("strips windows separators", sanitizeName("C:\\windows\\a.pdf", "x") === "a.pdf", sanitizeName("C:\\windows\\a.pdf", "x"));
  check("drops control chars", sanitizeName("a\u0000b.pdf", "x") === "ab.pdf", sanitizeName("a\u0000b.pdf", "x"));
  check("falls back when empty", sanitizeName("", "file.bin") === "file.bin");
  check("falls back when only dots", sanitizeName("...", "file.bin") === "file.bin");
}

// 2) 落盘：进 inbox/，返回的是给模型看的路径
{
  const result = saveAttachment({ workspace: dir, displayAs: "/workspace/inbox", name: "讲义.pdf", kind: "file", buffer });
  check("saved ok", result.ok === true, JSON.stringify(result));
  if (result.ok) {
    check("path is inside inbox", result.path.startsWith("/workspace/inbox/"), result.path);
    check("path keeps the name", result.path.endsWith("讲义.pdf"), result.path);
    const files = readdirSync(path.join(dir, "inbox"));
    check("file written on disk", files.length === 1 && files[0].endsWith("讲义.pdf"), JSON.stringify(files));
    check("bytes match", readFileSync(path.join(dir, "inbox", files[0])).length === buffer.length);
  }
}

// 3) 同名两次不覆盖（第二次通常是修正版）
{
  const second = saveAttachment({ workspace: dir, name: "讲义.pdf", kind: "file", buffer });
  check("second save does not overwrite", second.ok === true && second.path !== undefined);
  const files = readdirSync(path.join(dir, "inbox"));
  check("two distinct files kept", files.length === 2, JSON.stringify(files));
}

// 4) 上限与空文件
{
  const tooBig = saveAttachment({ workspace: dir, name: "big.pdf", kind: "file", buffer: Buffer.alloc(1024), maxBytes: 100 });
  check("oversize refused", tooBig.ok === false && /上限/.test(tooBig.reason), JSON.stringify(tooBig));
  const empty = saveAttachment({ workspace: dir, name: "empty.pdf", kind: "file", buffer: Buffer.alloc(0) });
  check("empty refused", empty.ok === false, JSON.stringify(empty));
}

// 5) 提示行：模型必须能看见路径，失败的也要说
{
  const note = attachmentNote([{ path: "/workspace/inbox/a.pdf", kind: "file" }, { path: "/workspace/inbox/b.png", kind: "image" }], ["c.pdf：超时"]);
  check("note lists the file", note.includes("/workspace/inbox/a.pdf"), note);
  check("note distinguishes image", note.includes("[图片]"), note);
  check("note reports failures", note.includes("超时"), note);
  check("note tells how to open", note.includes("read/bash"), note);
  check("empty note when nothing happened", attachmentNote([], []) === "");
}

rmSync(dir, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
