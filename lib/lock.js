'use strict';

/**
 * 极简键控串行队列：同一个 key 的任务串行执行，不同 key 之间并行。
 * 用于「同一 Application 内的关键写操作串行、不同 Application 并行」，
 * 不引入任何重量级锁或外部依赖。
 */
function createKeyedQueue() {
  const tails = new Map();

  function run(key, task) {
    const prev = tails.get(key) || Promise.resolve();

    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    // 本任务的 tail：前一个任务结束 → 等本任务的 gate 放开
    const tail = prev.then(() => gate);
    // 吞掉异常，避免某个任务失败导致整条队列永久阻塞
    tail.catch(() => {});
    tails.set(key, tail);

    return prev.then(async () => {
      try {
        return await task();
      } finally {
        release();
        // 队列排空后清理 Map 条目，避免长期占用内存
        tail.then(() => {
          if (tails.get(key) === tail) tails.delete(key);
        });
      }
    });
  }

  return { run };
}

/** 全局队列：索引、全局计数等跨应用共享状态的写入 */
const globalQueue = createKeyedQueue();
/** 应用级队列：同一 Application 内的关键写操作 */
const appQueue = createKeyedQueue();

module.exports = { createKeyedQueue, globalQueue, appQueue };
