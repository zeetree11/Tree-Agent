import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { OrchestrationStore } from "../src/orchestrations.ts";

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => { if (ok) { pass += 1; console.log("PASS " + name); } else { fail += 1; console.log("FAIL " + name + " " + detail); } };

const dir = mkdtempSync(path.join(tmpdir(), "pi-orch-"));
const store = new OrchestrationStore(path.join(dir, "runtime.db"));

const row = store.create({ id: "r1", thread: "qq:user:1", channel: "qq", chatId: "user:1", goal: "比较三个方案" });
check("created as running", row.status === "running" && row.goal === "比较三个方案", JSON.stringify(row));
check("runningCount sees it", store.runningCount() === 1);
check("unfinished lists it", store.unfinished().length === 1);
check("finish done", store.finish("r1", "done", { summary: "结论：B" }) === true);
check("second finish is a no-op", store.finish("r1", "failed", { error: "x" }) === false);
check("summary kept", store.get("r1")?.summary === "结论：B");
check("status is done", store.get("r1")?.status === "done");
check("nothing running", store.runningCount() === 0);
check("unfinished empty", store.unfinished().length === 0);

store.create({ id: "r2", thread: "qq:user:1", channel: "qq", chatId: "user:1", goal: "x" });
store.finish("r2", "stopped");
check("stopped recorded", store.get("r2")?.status === "stopped");

store.close();
try { rmSync(dir, { recursive: true, force: true }); } catch {}
console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail === 0 ? 0 : 1);