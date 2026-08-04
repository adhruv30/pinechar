// A branch is one named scenario with assertions in it. No framework, no
// dependencies — `node harness/run.js` and read the output.

const assert = require("node:assert/strict");

const groups = [];
let current = null;

function group(name) {
  current = { name, branches: [] };
  groups.push(current);
}

function branch(name, fn) {
  if (!current) group("ungrouped");
  current.branches.push({ name, fn });
}

const expect = {
  ok: (value, what) => assert.ok(value, what),
  is: (actual, expected, what) => assert.strictEqual(actual, expected, what),
  eq: (actual, expected, what) => assert.deepStrictEqual(actual, expected, what),
  throws: (fn, match, what) => assert.throws(fn, match, what),
  rejects: (promise, match, what) => assert.rejects(promise, match, what),
  match: (value, re, what) => assert.match(String(value), re, what),
  notMatch: (value, re, what) => assert.doesNotMatch(String(value), re, what),
};

async function run(filter) {
  let passed = 0;
  const failures = [];

  for (const g of groups) {
    const branches = g.branches.filter((b) => !filter || `${g.name} ${b.name}`.includes(filter));
    if (branches.length === 0) continue;

    console.log(`\n${g.name}`);
    for (const b of branches) {
      try {
        await b.fn();
        passed += 1;
        console.log(`  ok   ${b.name}`);
      } catch (err) {
        failures.push({ group: g.name, name: b.name, err });
        console.log(`  FAIL ${b.name}`);
      }
    }
  }

  console.log(`\n${passed} passed, ${failures.length} failed`);
  for (const f of failures) {
    console.log(`\n--- ${f.group} / ${f.name}`);
    console.log(f.err?.message ?? f.err);
    if (f.err?.stack && !f.err.message?.includes("\n")) {
      const frame = f.err.stack.split("\n").find((l) => l.includes("/harness/branches/"));
      if (frame) console.log(frame.trim());
    }
  }

  process.exitCode = failures.length === 0 ? 0 : 1;
}

module.exports = { group, branch, expect, run };
