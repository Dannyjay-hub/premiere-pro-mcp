/**
 * Claude Desktop runs a disposable probe copy of the server that only sends
 * `server/discover`. Binding the UXP loopback port for that copy would lock the
 * real server out, so the bridge starts on the first other JSON-RPC request.
 */
const METHOD_PATTERN = /"method"\s*:\s*"([^"]+)"/g;
// Longest `"method" : "<name>"` fragment worth carrying across a chunk boundary.
const CARRY_CHARS = 160;

export function nonDiscoverMethodSeen(text: string): boolean {
  for (const match of text.matchAll(METHOD_PATTERN)) {
    if (match[1] !== "server/discover") return true;
  }
  return false;
}

export interface LazyUxpStartOptions {
  start: () => Promise<void>;
  isPortInUse: (error: unknown) => boolean;
  retryMs?: number;
  onBusy?: () => void;
  onError?: (error: unknown) => void;
  onStarted?: () => void;
}

export interface LazyUxpStart {
  /** Feed raw stdin text; starts the bridge once a non-discover request is seen. */
  observe: (chunk: string | Buffer) => void;
  stop: () => void;
}

export function createLazyUxpStart(options: LazyUxpStartOptions): LazyUxpStart {
  const retryMs = options.retryMs ?? 3000;
  let triggered = false;
  let stopped = false;
  let started = false;
  let timer: NodeJS.Timeout | undefined;
  let tail = "";
  let busyReported = false;

  const attempt = async (): Promise<void> => {
    if (stopped || started) return;
    try {
      await options.start();
      started = true;
      options.onStarted?.();
    } catch (error) {
      if (options.isPortInUse(error)) {
        if (!busyReported) {
          busyReported = true;
          options.onBusy?.();
        }
        if (!stopped) {
          timer = setTimeout(() => void attempt(), retryMs);
          timer.unref();
        }
      } else {
        options.onError?.(error);
      }
    }
  };

  return {
    observe(chunk) {
      if (triggered || stopped) return;
      const text = tail + String(chunk);
      tail = text.slice(-CARRY_CHARS);
      if (!nonDiscoverMethodSeen(text)) return;
      triggered = true;
      tail = "";
      void attempt();
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
