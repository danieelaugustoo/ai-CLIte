import { test } from "node:test";
import { strict as assert } from "node:assert";
import { isValidModel } from "../validation";

test("aceita nomes de modelo comuns", () => {
  for (const model of ["sonnet", "opus", "claude-sonnet-5-5", "claude-sonnet-4-5[1m]", "provider/model:tag"]) {
    assert.equal(isValidModel(model), true, model);
  }
});

test("recusa metacaracteres de shell", () => {
  for (const model of ["sonnet & calc", "opus | dir", "x; rm -rf /", "a^b", "a%PATH%", "a!b", 'a"b', "a`b", "a$(b)", "a b"]) {
    assert.equal(isValidModel(model), false, model);
  }
});

test("recusa vazio, quebra de linha e nomes longos demais", () => {
  assert.equal(isValidModel(""), false);
  assert.equal(isValidModel("sonnet\nopus"), false);
  assert.equal(isValidModel("a".repeat(100)), true);
  assert.equal(isValidModel("a".repeat(101)), false);
});
