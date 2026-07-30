export function monitorAppServer(client, { onRuntimeExit = () => {} } = {}) {
  let phase = "startup";
  let failure = null;
  let rejectStartup;
  const startupFailure = new Promise((_, reject) => {
    rejectStartup = reject;
  });
  // The close can arrive before the first startup await installs its race.
  // Keep the rejection handled while retaining it for that later race.
  void startupFailure.catch(() => {});

  const onClose = (details = {}) => {
    if (phase === "disposed" || details.expected || failure) return;
    const { code = null, signal = null } = details;
    const error = new Error(
      `Codex app-server exited unexpectedly (code=${code}, signal=${signal}).`,
    );
    error.code = "APP_SERVER_EXITED";
    error.details = { code, signal };
    failure = { error, details: { ...details, code, signal } };
    if (phase === "runtime") {
      onRuntimeExit(error, failure.details);
    } else {
      rejectStartup(error);
    }
  };

  client.on("close", onClose);
  if (!client.child) onClose({ code: null, signal: null, expected: false });

  return {
    waitFor(operation) {
      if (failure) return Promise.reject(failure.error);
      return Promise.race([Promise.resolve(operation), startupFailure]);
    },
    activateRuntime() {
      if (failure) throw failure.error;
      phase = "runtime";
    },
    dispose() {
      if (phase === "disposed") return;
      phase = "disposed";
      client.off("close", onClose);
    },
  };
}
