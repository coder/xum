// Deliberately model XML/native work that stops servicing JavaScript callbacks.
process.once("message", () => {
  if (!process.send) throw new Error("Expected fixture IPC channel");
  process.send("filtering", undefined, undefined, () => {
    while (true) {
      // The parent must SIGKILL and reap us, not rely on a cooperative worker timer.
    }
  });
});
