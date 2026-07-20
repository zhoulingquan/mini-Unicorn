import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/**
 * 简单的 debounce 工具:延迟 wait 毫秒后执行 fn,期间再次调用会重置计时器。
 * 返回的函数带有 cancel 和 flush 方法,便于在组件卸载时清理或同步写入挂起的最后一次调用。
 */
export function debounce<Args extends unknown[]>(
  fn: (...args: Args) => void,
  wait: number,
): ((...args: Args) => void) & { cancel: () => void; flush: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastArgs: Args | null = null;

  const debounced = (...args: Args) => {
    lastArgs = args;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      const pending = lastArgs;
      lastArgs = null;
      if (pending) fn(...pending);
    }, wait);
  };

  debounced.cancel = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    lastArgs = null;
  };

  debounced.flush = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (lastArgs) {
      const pending = lastArgs;
      lastArgs = null;
      fn(...pending);
    }
  };

  return debounced;
}
