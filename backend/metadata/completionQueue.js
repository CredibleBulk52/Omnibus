'use strict';

// Serialize complete reconciliation runs. A new caller must not mistake an
// already-running/older pass for completion of its own publication follow-up.
function createCompletionQueue() {
  let tail = Promise.resolve();
  return action => {
    const result = tail.then(action);
    tail = result.catch(() => {}); // A failed run must not poison later runs.
    return result;
  };
}
module.exports = { createCompletionQueue };
