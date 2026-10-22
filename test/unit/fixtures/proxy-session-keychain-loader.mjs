// Only this subprocess fixture substitutes native credential access. Production
// session storage, locking, ownership checks and deletion run unchanged.
export async function resolve(specifier, context, nextResolve) {
  if (/\/auth\/keychain\.(?:js|ts)(?:\?|$)/.test(specifier)) {
    return {
      url: new URL('./proxy-session-keychain.mjs', import.meta.url).href,
      shortCircuit: true,
    };
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (/\/src\/lib\/auth\/keychain\.(?:js|ts)(?:\?|$)/.test(url)) {
    return {
      format: 'module',
      source: `export * from ${JSON.stringify(new URL('./proxy-session-keychain.mjs', import.meta.url).href)};`,
      shortCircuit: true,
    };
  }
  return nextLoad(url, context);
}
