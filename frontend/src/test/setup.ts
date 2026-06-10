import '@testing-library/jest-dom/vitest';

// jsdom doesn't include ResizeObserver — provide a no-op stub
(globalThis as typeof globalThis & { ResizeObserver: unknown }).ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

// jsdom doesn't include EventSource — provide a no-op stub so components that
// open a server-sent-events stream (useDashboardEvents) don't crash in tests.
class EventSourceStub {
  static readonly CONNECTING = 0 as const;
  static readonly OPEN = 1 as const;
  static readonly CLOSED = 2 as const;
  readonly CONNECTING = 0 as const;
  readonly OPEN = 1 as const;
  readonly CLOSED = 2 as const;
  url: string;
  withCredentials: boolean;
  readyState: 0 | 1 | 2 = 0;
  onopen: ((e: Event) => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  constructor(url: string | URL, init?: { withCredentials?: boolean }) {
    this.url = typeof url === 'string' ? url : url.toString();
    this.withCredentials = !!init?.withCredentials;
  }
  addEventListener() {}
  removeEventListener() {}
  close() { this.readyState = 2; }
  dispatchEvent() { return true; }
}
(globalThis as typeof globalThis & { EventSource: unknown }).EventSource = EventSourceStub;
