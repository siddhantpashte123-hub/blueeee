'use strict';

/** Minimal pattern router: '/api/bots/:id/files' style paths. */
class Router {
  constructor() {
    this.routes = [];
  }

  add(method, pattern, handler, opts = {}) {
    const keys = [];
    const escaped = pattern
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\/:([A-Za-z0-9_]+)/g, (_match, key) => {
        keys.push(key);
        return '/([^/]+)';
      });
    this.routes.push({
      method,
      regex: new RegExp(`^${escaped}/?$`),
      keys,
      handler,
      raw: Boolean(opts.raw),
      body: opts.body || 'json'
    });
    return this;
  }

  get(pattern, handler, opts) {
    return this.add('GET', pattern, handler, opts);
  }

  post(pattern, handler, opts) {
    return this.add('POST', pattern, handler, opts);
  }

  put(pattern, handler, opts) {
    return this.add('PUT', pattern, handler, opts);
  }

  patch(pattern, handler, opts) {
    return this.add('PATCH', pattern, handler, opts);
  }

  delete(pattern, handler, opts) {
    return this.add('DELETE', pattern, handler, opts);
  }

  async dispatch(ctx) {
    for (const route of this.routes) {
      if (route.method !== ctx.method) continue;
      const match = route.regex.exec(ctx.pathname);
      if (!match) continue;
      ctx.params = {};
      route.keys.forEach((key, i) => {
        try {
          ctx.params[key] = decodeURIComponent(match[i + 1]);
        } catch (_) {
          ctx.params[key] = match[i + 1];
        }
      });
      ctx.rawBody = route.raw;
      ctx.bodyMode = route.body;
      await route.handler(ctx);
      return true;
    }
    return false;
  }
}

module.exports = Router;
