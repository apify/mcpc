const originalSetTimeout = global.setTimeout;
global.setTimeout = (callback, timeoutMillis, ...args) =>
  originalSetTimeout(callback, timeoutMillis === 120_000 ? 300 : timeoutMillis, ...args);
