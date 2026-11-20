// Ambient typings for the two Node built-ins the UI test suites use.
// The UI package carries no @types/node (its tsconfig "types" is
// ["vite/client"]), and the suites under ui/tests/ run on the gate
// host under Node's own test runner — never in the browser bundle and
// never in `npm run build`'s include set (src/ + vite.config.ts).
// Declaring just the used surface keeps the standalone test compile
// (see the run route in preflop-stack.test.ts) clean without adding
// a dependency. This file is a global script on purpose: the
// declarations must be ambient modules, not augmentations.
declare module 'node:test' {
  export function test(name: string, fn: () => void | Promise<void>): void;
}

declare module 'node:assert/strict' {
  interface StrictAssert {
    equal(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): void;
  }
  const assert: StrictAssert;
  export default assert;
}
