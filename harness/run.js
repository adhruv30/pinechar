// node harness/run.js [filter]
//
// Loads the real extension sources into a stubbed Chrome and runs every branch
// against them. No dependencies, no build step.

const { run } = require("./runner.js");

require("./branches/drift.js");
require("./branches/worker.js");
require("./branches/overlay.js");

run(process.argv[2]);
