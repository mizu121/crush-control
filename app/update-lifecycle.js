'use strict';
// A shared cleanup barrier for ordinary Quit and the explicit update handoff.
function createUpdateLifecycle({ keyboard, stopPolling, onQuiesce = () => {} }) {
  let operation = null, started = false, complete = false;
  function shutdown() {
    if (!operation) {
      started = true;
      let resolve, reject;
      // Establish the barrier before observers can throw or re-enter shutdown.
      operation = new Promise((yes, no) => { resolve = yes; reject = no; });
      let preparationError = null;
      try { stopPolling(); } catch (error) { preparationError = error; }
      try { onQuiesce(); } catch (error) { preparationError ||= error; }
      Promise.resolve().then(() => keyboard.shutdown()).then(() => {
        if (keyboard.via?.closeFailure || keyboard.via?.connected) throw new Error('The keyboard connection could not be released. Quit Crush Control and try the update again.');
        if (preparationError) throw preparationError;
        complete = true;
      }).then(resolve, reject);
    }
    return operation;
  }
  return { shutdown, get started() { return started; }, get complete() { return complete; } };
}
module.exports = { createUpdateLifecycle };
