import type * as rdfjs from "@rdfjs/types";

import { MemoryStreamEmitter } from "./memory-stream-emitter.ts";

type Listener = (...args: unknown[]) => void;

/**
 * MemoryStream is a minimal, zero-dependency RDF/JS Stream that replays a
 * fixed set of quads with Node Readable-compatible semantics:
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
export class MemoryStream extends MemoryStreamEmitter
  implements rdfjs.Stream<rdfjs.Quad> {
  private _ended = false;
  private _flowing = false;
  private _readStarted = false;

  public constructor(private readonly quads: rdfjs.Quad[]) {
    super();
  }

  public read(): rdfjs.Quad | null {
    this._readStarted = true;
    const quad = this.quads.shift();
    if (quad === undefined) {
      this._end();
      return null;
    }
    return quad;
  }

  public [Symbol.iterator](): Iterator<rdfjs.Quad> {
    return this.quads[Symbol.iterator]();
  }

  public destroy(error?: Error): void {
    if (error) {
      this.emit("error", error);
    }
    this._ended = true;
    this.removeAllListeners();
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
    if (eventName === "readable" && !this._ended && this.quads.length > 0) {
      queueMicrotask(() => {
        if (
          !this._ended && this.quads.length > 0 &&
          this.listenerCount("readable") > 0
        ) {
          this.emit("readable");
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

  private _startFlowing(): void {
    this._flowing = true;
    queueMicrotask(() => this._drain());
  }

  private _drain(): void {
    if (this._ended || !this._flowing) {
      return;
    }
    while (this.listenerCount("data") > 0) {
      const quad = this.quads.shift();
      if (quad === undefined) {
        break;
      }
      this.emit("data", quad);
    }
    if (this.quads.length === 0) {
      this._end();
    }
  }

  private _end(): void {
    if (this._ended) {
      return;
    }
    this._ended = true;
    this.emit("end");
  }
}
