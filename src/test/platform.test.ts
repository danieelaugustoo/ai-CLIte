import { test } from "node:test";
import { strict as assert } from "node:assert";
import { isPlatformBlocked, WINDOWS_VERIFIED } from "../platform";

test("o Windows fica bloqueado enquanto não for verificado", () => {
  assert.equal(WINDOWS_VERIFIED, false);
  assert.equal(isPlatformBlocked("win32"), true);
});

test("Linux e macOS não são bloqueados", () => {
  assert.equal(isPlatformBlocked("linux"), false);
  assert.equal(isPlatformBlocked("darwin"), false);
});

test("liberar o Windows exige mudar a constante de build", () => {
  assert.equal(isPlatformBlocked("win32", true), false);
});
