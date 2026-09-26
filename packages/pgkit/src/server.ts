/** Close an HTTP server now: stop accepting, drop idle and in-flight connections. */
export function closeServer(server: { close: (cb?: (err?: Error) => void) => unknown; closeAllConnections?: () => void }): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections?.();
  });
}
