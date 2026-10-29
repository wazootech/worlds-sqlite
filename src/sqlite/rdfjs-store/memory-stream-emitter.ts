type Listener = (...args: unknown[]) => void;

/**
 * MemoryStreamEmitter holds the EventEmitter surface of MemoryStream
 * (listener registry and the non-flow-controlling methods), kept separate so
 * the stream module stays focused on replay semantics.
 */
export abstract class MemoryStreamEmitter {
  protected _listeners: Map<string | symbol, Listener[]> = new Map<
    string | symbol,
    Listener[]
  >();
  protected _maxListeners: number = 10;

  public abstract on(eventName: string | symbol, listener: Listener): this;

  public addListener(eventName: string | symbol, listener: Listener): this {
    return this.on(eventName, listener);
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
    for (const fn of [...list]) {
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
}
