const DETAIL_MAX_AGE = 60000;

export class LinearDetails {
  seq = 0;
  cache = new Map();
  expanded = null;
  data = null;

  clear() {
    this.seq++;
    this.cache.clear();
    this.expanded = null;
    this.data = null;
  }

  toggle(identifier, cx, read, isCurrent) {
    if (!isCurrent()) return;
    const seq = ++this.seq;
    this.expanded = this.expanded === identifier ? null : identifier;
    const cached = this.cache.get(identifier);
    this.data = this.expanded && Date.now() < cached?.expiresAt ? cached.data : null;
    cx.notify();
    if (!this.expanded || this.data) return;

    cx.spawn(async cx => {
      const data = await read(['issue', identifier]);
      if (seq !== this.seq || !isCurrent()) return;
      this.data = data ?? { error: 'helper' };
      if (data?.issue) this.cache.set(identifier, { data, expiresAt: Date.now() + DETAIL_MAX_AGE });
      cx.notify();
    });
  }
}
