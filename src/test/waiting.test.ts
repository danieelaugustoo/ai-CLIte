import { test } from "node:test";
import { strict as assert } from "node:assert";
import { cancellableWait } from "../waiting";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("devolve o valor quando a resposta chega a tempo", async () => {
  const w = cancellableWait(Promise.resolve("Enviar"), 1000);
  assert.equal(await w.promise, "Enviar");
});

test("cancelar resolve com undefined, mesmo se a resposta nunca vier", async () => {
  const never = new Promise<string>(() => {});
  const w = cancellableWait(never, 0);
  setTimeout(() => w.cancel(), 20);
  assert.equal(await w.promise, undefined);
});

test("expira com undefined se ninguém responder", async () => {
  const never = new Promise<string>(() => {});
  const t0 = Date.now();
  const w = cancellableWait(never, 60);
  assert.equal(await w.promise, undefined);
  assert.ok(Date.now() - t0 >= 50);
});

test("erro na fonte conta como cancelamento", async () => {
  const w = cancellableWait(Promise.reject(new Error("falhou")), 1000);
  assert.equal(await w.promise, undefined);
});

test("cancelar depois de resolver é inofensivo, e o timer não fica pendente", async () => {
  const w = cancellableWait(Promise.resolve("ok"), 5000);
  assert.equal(await w.promise, "ok");
  w.cancel();
  w.cancel();
  await sleep(10); // se o timer de 5 s ficasse ativo, o teste não terminaria sozinho
});
