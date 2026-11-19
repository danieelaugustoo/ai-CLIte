import { test } from "node:test";
import { strict as assert } from "node:assert";
import * as os from "os";
import { launchCli } from "../launcher";
import { LineSplitter, terminateTree, Watchdog } from "../lifecycle";

const posix = process.platform !== "win32";

function start(script: string) {
  return launchCli(process.execPath, ["-e", script], { cwd: os.tmpdir(), env: process.env });
}

function closed(child: ReturnType<typeof start>): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve) => child.on("close", (code, signal) => resolve({ code, signal })));
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("terminateTree: um processo que ignora SIGINT e SIGTERM acaba por SIGKILL", { skip: !posix }, async () => {
  const child = start("process.on('SIGINT',()=>{});process.on('SIGTERM',()=>{});setInterval(()=>{},1000);console.log('pronto')");
  await new Promise((r) => child.stdout.once("data", r));
  const done = closed(child);
  terminateTree(child, { sigintMs: 100, sigkillMs: 300 });
  const r = await done;
  assert.equal(r.signal, "SIGKILL");
});

test("terminateTree: um processo normal sai já com o SIGINT", { skip: !posix }, async () => {
  const child = start("setInterval(()=>{},1000);console.log('pronto')");
  await new Promise((r) => child.stdout.once("data", r));
  const done = closed(child);
  terminateTree(child, { sigintMs: 2000, sigkillMs: 5000 });
  const r = await done;
  assert.equal(r.signal, "SIGINT");
});

test("terminateTree: os filhos do processo também morrem", { skip: !posix }, async () => {
  const child = start(
    "const {spawn}=require('child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log(c.pid);setInterval(()=>{},1000)"
  );
  const pid = await new Promise<number>((resolve) => child.stdout.once("data", (d) => resolve(Number(String(d).trim()))));
  assert.ok(alive(pid), "o filho deveria estar vivo antes");
  const done = closed(child);
  terminateTree(child, { sigintMs: 200, sigkillMs: 600 });
  await done;
  for (let i = 0; i < 30 && alive(pid); i++) {
    await sleep(100);
  }
  assert.equal(alive(pid), false, "o filho não pode sobrar");
});

test("terminateTree: processo que já terminou não faz nada", { skip: !posix }, async () => {
  const child = start("process.exit(0)");
  await closed(child);
  terminateTree(child, { sigintMs: 10, sigkillMs: 20 });
});

test("Watchdog: dispara por inatividade, e touch adia", async () => {
  const fired: string[] = [];
  const w = new Watchdog(80, 0, (k) => fired.push(k));
  await sleep(50);
  w.touch();
  await sleep(50);
  assert.deepEqual(fired, [], "o touch deveria ter adiado");
  await sleep(100);
  assert.deepEqual(fired, ["idle"]);
});

test("Watchdog: dispara pelo tempo total mesmo com sinais de vida", async () => {
  const fired: string[] = [];
  const w = new Watchdog(1000, 120, (k) => fired.push(k));
  const t = setInterval(() => w.touch(), 20);
  await sleep(220);
  clearInterval(t);
  assert.deepEqual(fired, ["total"]);
});

test("Watchdog: stop impede o disparo, e 0 desliga", async () => {
  const fired: string[] = [];
  const a = new Watchdog(40, 40, (k) => fired.push(k));
  a.stop();
  const b = new Watchdog(0, 0, (k) => fired.push(k));
  await sleep(120);
  b.stop();
  assert.deepEqual(fired, []);
});

test("LineSplitter: junta pedaços e separa linhas", () => {
  const s = new LineSplitter(100);
  assert.deepEqual(s.push('{"a":'), { lines: [], overflow: false });
  assert.deepEqual(s.push('1}\n{"b":2}\nresto'), { lines: ['{"a":1}', '{"b":2}'], overflow: false });
  assert.equal(s.flush(), "resto");
});

test("LineSplitter: linha enorme é descartada e a seguinte passa", () => {
  const s = new LineSplitter(10);
  const r1 = s.push("x".repeat(25));
  assert.equal(r1.overflow, true);
  const r2 = s.push("yyyy\nok\n");
  assert.deepEqual(r2.lines, ["ok"]);
  const s2 = new LineSplitter(10);
  const r3 = s2.push("z".repeat(30) + "\nboa\n");
  assert.equal(r3.overflow, true);
  assert.deepEqual(r3.lines, ["boa"]);
});

test("LineSplitter: nunca guarda mais que o limite", () => {
  const s = new LineSplitter(1000);
  for (let i = 0; i < 100; i++) {
    s.push("a".repeat(500));
  }
  assert.equal(s.flush().length <= 1000, true);
});
