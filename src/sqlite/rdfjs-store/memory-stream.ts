import type * as rdfjs from "@rdfjs/types";

type Listener = (...args: unknown[]) => void;

/**
 * MemoryStream is a minimal, zero-dependency RDF/JS Stream that consumes an
 * iterable of quads with Node Readable-compatible semantics:
 *
 * - attaching a `data` listener switches to flow mode and drains the quads,
 * - attaching a `readable` listener (or calling `read()`) enables pull mode,
 * - attaching only `end`/`error` listeners (a bare completion signal) ends
 *   the stream once nothing else is consuming it,
 * - `end` is only emitted after every quad has been consumed.
 *
 * It implements the full EventEmitter surface required by the `rdfjs.Stream`
 * interface without depending on Node's `events` module, keeping the package
 * runtime dependency-free and browser-friendly.
 */
export class MemoryStream implements rdfjs.Stream<rdfjs.Quad> {
  private _listeners = new Map<string | symbol, Listener[]>();
  private _maxListeners = 10;
  private _ended = false;
  private _flowing = false;
  private _readStarted = false;

  // defines an iterator that will be used to read quads from the provided iterable
  private readonly _iterator: Iterator<rdfjs.Quad>;
  private _buffered?: rdfjs.Quad;

  public constructor(quads: Iterable<rdfjs.Quad>) {
    this._iterator = quads[Symbol.iterator]();
  }

  public read(): rdfjs.Quad | null {
    this._readStarted = true;
    const quad = this._buffered;
    this._buffered = undefined;
    return quad ?? this._readAndNotify();
  }

  public *[Symbol.iterator](): IterableIterator<rdfjs.Quad> {
    let quad: rdfjs.Quad | null;
    while ((quad = this.read()) !== null) {
      yield quad;
    }
  }

  public destroy(error?: Error): void {
    this._stop();
    if (error) {
      this.emit("error", error);
    }
    this.removeAllListeners();
  }

  public addListener(eventName: string | symbol, listener: Listener): this {
    return this.on(eventName, listener);
  }

  public on(eventName: string | symbol, listener: Listener): this {
    const list = this._listeners.get(eventName);
    if (list) {
      list.push(listener);
    } else {
      this._listeners.set(eventName, [listener]);
    }
    if (eventName === "data" && !this._ended && !this._flowing) {
      this._startFlowing();
    }
    if (eventName === "readable" && !this._ended) {
      queueMicrotask(() => {
        if (!this._ended && this.listenerCount("readable") > 0) {
          this._buffered ??= this._readAndNotify() ?? undefined;
          if (this._buffered) {
            this.emit("readable");
          }
        }
      });
    }
    if (eventName === "end" && !this._ended) {
      queueMicrotask(() => {
        if (
          !this._ended && !this._flowing && !this._readStarted &&
          this.listenerCount("data") === 0 &&
          this.listenerCount("readable") === 0
        ) {
          this._end();
        }
      });
    }
    return this;
  }

  public once(eventName: string | symbol, listener: Listener): this {
    const wrapper: Listener = (...args) => {
      this.removeListener(eventName, wrapper);
      listener(...args);
    };
    return this.on(eventName, wrapper);
  }

  public prependListener(eventName: string | symbol, listener: Listener): this {
    const list = this._listeners.get(eventName);
    if (list) {
      list.unshift(listener);
    } else {
      this._listeners.set(eventName, [listener]);
    }
    return this;
  }

  public prependOnceListener(
    eventName: string | symbol,
    listener: Listener,
  ): this {
    const wrapper: Listener = (...args) => {
      this.removeListener(eventName, wrapper);
      listener(...args);
    };
    return this.prependListener(eventName, wrapper);
  }

  public removeListener(eventName: string | symbol, listener: Listener): this {
    const list = this._listeners.get(eventName);
    if (list) {
      const index = list.indexOf(listener);
      if (index >= 0) {
        list.splice(index, 1);
      }
    }
    return this;
  }

  public off(eventName: string | symbol, listener: Listener): this {
    return this.removeListener(eventName, listener);
  }

  public removeAllListeners(eventName?: string | symbol): this {
    if (eventName === undefined) {
      this._listeners.clear();
    } else {
      this._listeners.delete(eventName);
    }
    return this;
  }

  public setMaxListeners(n: number): this {
    this._maxListeners = n;
    return this;
  }

  public getMaxListeners(): number {
    return this._maxListeners;
  }

  public listeners(eventName: string | symbol): Listener[] {
    return [...(this._listeners.get(eventName) ?? [])];
  }

  public rawListeners(eventName: string | symbol): Listener[] {
    return [...(this._listeners.get(eventName) ?? [])];
  }

  public emit(eventName: string | symbol, ...args: unknown[]): boolean {
    const list = this._listeners.get(eventName);
    if (!list || list.length === 0) {
      return false;
    }
    // A snapshot: a once() listener removes itself while this loop runs.
    for (const fn of list.slice()) {
      fn.apply(this, args);
    }
    return true;
  }

  public listenerCount(eventName: string | symbol): number {
    return this._listeners.get(eventName)?.length ?? 0;
  }

  public eventNames(): Array<string | symbol> {
    return [...this._listeners.keys()];
  }

  private _startFlowing(): void {
    this._flowing = true;
    queueMicrotask(() => this._drain());
  }

  private _drain(): void {
    try {
      while (!this._ended && this.listenerCount("data") > 0) {
        const quad = this.read();
        if (quad === null) {
          break;
        }
        this.emit("data", quad);
      }
    } finally {
      this._flowing = false;
    }
  }

  private _nextQuad(): rdfjs.Quad | null {
    const next = this._iterator.next();
    return next.done ? null : next.value;
  }

  // used to read the next quad if current buffer is empty. returns null if none
  // found, which happens when iterator is exhausted or stream ended, or error occurs.
  private _readAndNotify(): rdfjs.Quad | null {
    if (this._ended) {
      return null;
    }
    let quad: rdfjs.Quad | null;
    try {
      quad = this._nextQuad();
    } catch (error) {
      this._stop();
      if (!this.emit("error", error)) {
        throw error;
      }
      return null;
    }
    if (quad === null) {
      this._end();
    }
    return quad;
  }

  private _stop(): void {
    if (!this._ended) {
      this._ended = true;
      this._buffered = undefined;
      this._iterator.return?.();
    }
  }

  private _end(): void {
    if (this._ended) {
      return;
    }
    this._stop();
    this.emit("end");
  }
}
