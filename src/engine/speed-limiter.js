'use strict';

/**
 * Token bucket shared by every connection. A rate of 0 means unlimited.
 * The bucket holds at most one second of traffic so bursts stay bounded.
 */
class SpeedLimiter {
  constructor(bytesPerSecond = 0) {
    this.setRate(bytesPerSecond);
  }

  setRate(bytesPerSecond) {
    this.rate = Math.max(0, Number(bytesPerSecond) || 0);
    this.tokens = this.rate;
    this.last = Date.now();
  }

  #refill() {
    const now = Date.now();
    this.tokens = Math.min(this.rate, this.tokens + ((now - this.last) / 1000) * this.rate);
    this.last = now;
  }

  /** Waits until `bytes` may pass. Large chunks are allowed to drive the bucket negative. */
  async take(bytes, signal) {
    if (this.rate === 0) return;
    this.#refill();
    this.tokens -= bytes;
    if (this.tokens >= 0) return;
    const waitMs = (-this.tokens / this.rate) * 1000;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, waitMs);
      signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(signal.reason);
      }, { once: true });
    });
  }
}

module.exports = { SpeedLimiter };
