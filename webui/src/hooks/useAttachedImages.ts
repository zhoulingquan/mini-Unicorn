import { useCallback, useEffect, useRef, useState } from "react";

import { encodeImage, type EncodeFailure } from "@/lib/imageEncode";

/** Lifecycle stages of one attachment:
 *
 * - ``encoding``  — posted to the Worker; chip shows a spinner
 * - ``ready``     — ``dataUrl`` available; safe to submit
 * - ``error``     — validation / decode failure; chip shows inline error
 */
export type AttachmentStatus = "encoding" | "ready" | "error";

export interface AttachedImage {
  id: string;
  file: File;
  /** Optimistic ``blob:`` preview URL; revoked on ``remove`` / ``clear`` /
   * unmount. */
  previewUrl: string;
  status: AttachmentStatus;
  /** Populated when ``status === "ready"``. */
  dataUrl?: string;
  /** Size of the final encoded payload (base64 bytes decoded). */
  encodedBytes?: number;
  /** Whether the Worker re-encoded the image to hit the size budget. */
  normalized?: boolean;
  /** Human-readable validation / encoding error when ``status === "error"``. */
  error?: AttachmentError;
  /** 是否为文档类型(非图片)。文档走直接 base64 路径,不经过 image worker。 */
  isDocument?: boolean;
}

/** Machine-readable rejection reasons surfaced as inline chip errors.
 *
 * Callers localize these via the ``composer.imageRejected.*`` i18n table. */
export type AttachmentError =
  | "unsupported_type"   // server whitelist excludes this MIME
  | "too_many_images"    // per-message cap (4) reached before enqueue
  | "magic_mismatch"     // extension lies about the real content
  | "decode_failed"      // Worker couldn't decode / re-encode
  | "too_large"          // even after normalization we exceed the budget
  | "io";                // file read failed at the browser layer

export const MAX_IMAGES_PER_MESSAGE = 4;

/** 文档 MIME 白名单 — 与后端 `utils/document.py` 的 `SUPPORTED_EXTENSIONS` 对齐。
 * 这些文件不经过 image worker 的 magic-byte 检测,直接 base64 编码上传,
 * 后端 `extract_documents()` 会自动提取文本注入对话。 */
const DOCUMENT_MIMES: ReadonlySet<string> = new Set([
  // Office 文档
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // .docx
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", // .xlsx
  "application/vnd.openxmlformats-officedocument.presentationml.presentation", // .pptx
  // 纯文本类(浏览器对未知后缀通常返回 application/octet-stream,这里也放行)
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
  "application/xml",
  "text/xml",
  "text/html",
  "application/x-yaml",
  "text/yaml",
  // 通用二进制(依赖后端按扩展名解析)
  "application/octet-stream",
]);

/** 图片 MIME 白名单 — 走 image worker 路径(magic-byte 校验 + 归一化)。 */
const IMAGE_MIMES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

/** 全部接受的 MIME 白名单 — 镜像后端 `_UPLOAD_MIME_ALLOWED`。 */
const ACCEPTED_MIMES: ReadonlySet<string> = new Set([
  ...IMAGE_MIMES,
  ...DOCUMENT_MIMES,
]);

/** 文档 MIME 对应的展示用扩展名(用于 chip 图标和 tooltip)。 */
export const DOCUMENT_EXTENSIONS: string =
  ".pdf,.docx,.xlsx,.pptx,.txt,.md,.csv,.json,.xml,.html,.htm,.log,.yaml,.yml,.toml,.ini,.cfg";

/** 判断 MIME 是否为文档类型(非图片)。 */
export function isDocumentMime(mime: string): boolean {
  return DOCUMENT_MIMES.has(mime);
}

/** 判断 MIME 是否为图片类型。 */
export function isImageMime(mime: string): boolean {
  return IMAGE_MIMES.has(mime);
}

function uuid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return (crypto as Crypto).randomUUID();
  }
  return `img-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function mapEncodeFailure(reason: EncodeFailure["reason"]): AttachmentError {
  switch (reason) {
    case "invalid_mime":
    case "magic_mismatch":
      return "magic_mismatch";
    case "too_large_after_normalize":
      return "too_large";
    case "io":
      return "io";
    case "decode_failed":
    default:
      return "decode_failed";
  }
}

/** 文档文件的大小上限(50MB,与后端 `_MAX_EXTRACT_FILE_SIZE` 对齐)。 */
const MAX_DOCUMENT_BYTES = 50 * 1024 * 1024;

/** 将文档文件直接 base64 编码为 data URL,不经过 image worker。
 *
 * 文档文件没有 magic bytes 可供图片 worker 校验,且无需归一化,
 * 直接读取 + base64 编码即可。后端会按扩展名调用对应的解析器。 */
async function encodeDocument(file: File): Promise<
  | { ok: true; dataUrl: string; bytes: number }
  | { ok: false; reason: AttachmentError }
> {
  if (file.size > MAX_DOCUMENT_BYTES) {
    return { ok: false, reason: "too_large" };
  }
  try {
    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    // 分块 base64 编码,避免大文件导致 btoa 栈溢出
    const CHUNK = 0x8000;
    let binary = "";
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode.apply(
        null,
        bytes.subarray(i, i + CHUNK) as unknown as number[],
      );
    }
    const base64 = btoa(binary);
    const mime = file.type || "application/octet-stream";
    const dataUrl = `data:${mime};base64,${base64}`;
    return { ok: true, dataUrl, bytes: buffer.byteLength };
  } catch {
    return { ok: false, reason: "io" };
  }
}

export interface UseAttachedImagesApi {
  images: AttachedImage[];
  /** Enqueue new files. Returns the list of rejected files so the caller can
   * surface inline errors. Files rejected client-side (wrong MIME, limit) are
   * *not* added to ``images`` — only recoverable encoding failures show up as
   * error chips. */
  enqueue: (files: Iterable<File>) => {
    rejected: Array<{ file: File; reason: AttachmentError }>;
  };
  remove: (id: string) => { nextFocusId: string | null };
  /** Revoke every staged blob URL and drop all attachments. Called after a
   * successful submit — the optimistic bubble holds onto an independent
   * ``data:`` URL so tearing down blob previews here is safe. */
  clear: () => void;
  /** ``true`` when at least one image is still encoding — Send should wait. */
  encoding: boolean;
  /** ``true`` when we've hit ``MAX_IMAGES_PER_MESSAGE``. */
  full: boolean;
}

/** Manage the lifecycle of images attached to the Composer.
 *
 * Responsibilities in one place:
 *   - validation (MIME whitelist, count cap)
 *   - blob URL creation + revocation
 *   - Worker orchestration
 *   - focus bookkeeping so keyboard delete doesn't strand the user
 */
export function useAttachedImages(): UseAttachedImagesApi {
  const [images, setImages] = useState<AttachedImage[]>([]);
  // Ref mirror so ``enqueue`` can see the authoritative length when invoked
  // multiple times in a single tick (rapid file selection, drag of many
  // files, paste storms). ``state`` is stale for that second + call.
  const imagesRef = useRef<AttachedImage[]>([]);
  imagesRef.current = images;

  const setEntry = useCallback((id: string, patch: Partial<AttachedImage>) => {
    setImages((prev) => {
      const next = prev.map((img) => (img.id === id ? { ...img, ...patch } : img));
      imagesRef.current = next;
      return next;
    });
  }, []);

  const enqueue = useCallback(
    (files: Iterable<File>) => {
      const rejected: Array<{ file: File; reason: AttachmentError }> = [];
      const toAdd: AttachedImage[] = [];
      let slot = MAX_IMAGES_PER_MESSAGE - imagesRef.current.length;

      for (const file of files) {
        if (!ACCEPTED_MIMES.has(file.type)) {
          rejected.push({ file, reason: "unsupported_type" });
          continue;
        }
        if (slot <= 0) {
          rejected.push({ file, reason: "too_many_images" });
          continue;
        }
        slot -= 1;
        toAdd.push({
          id: uuid(),
          file,
          previewUrl: URL.createObjectURL(file),
          status: "encoding",
          isDocument: isDocumentMime(file.type),
        });
      }

      if (toAdd.length > 0) {
        const next = [...imagesRef.current, ...toAdd];
        imagesRef.current = next;
        setImages(next);
        // Fire the Worker after the commit so chips render first (good INP).
        for (const entry of toAdd) {
          queueMicrotask(() => {
            // 文档文件走直接 base64 编码,绕过 image worker 的 magic-byte 检测
            if (entry.isDocument) {
              encodeDocument(entry.file).then(
                (result) => {
                  if (result.ok) {
                    setEntry(entry.id, {
                      status: "ready",
                      dataUrl: result.dataUrl,
                      encodedBytes: result.bytes,
                      normalized: false,
                    });
                  } else {
                    setEntry(entry.id, {
                      status: "error",
                      error: result.reason,
                    });
                  }
                },
                () => {
                  setEntry(entry.id, {
                    status: "error",
                    error: "decode_failed",
                  });
                },
              );
              return;
            }
            // 图片文件走 image worker(magic-byte 校验 + 归一化)
            encodeImage(entry.file).then(
              (result) => {
                if (result.ok) {
                  setEntry(entry.id, {
                    status: "ready",
                    dataUrl: result.dataUrl,
                    encodedBytes: result.bytes,
                    normalized: result.normalized,
                  });
                } else {
                  setEntry(entry.id, {
                    status: "error",
                    error: mapEncodeFailure(result.reason),
                  });
                }
              },
              () => {
                setEntry(entry.id, {
                  status: "error",
                  error: "decode_failed",
                });
              },
            );
          });
        }
      }
      return { rejected };
    },
    [setEntry],
  );

  const remove = useCallback((id: string) => {
    let nextFocusId: string | null = null;
    setImages((prev) => {
      const idx = prev.findIndex((img) => img.id === id);
      if (idx === -1) return prev;
      const target = prev[idx];
      try {
        URL.revokeObjectURL(target.previewUrl);
      } catch {
        // No-op: previewUrl revocation is best-effort.
      }
      const next = [...prev.slice(0, idx), ...prev.slice(idx + 1)];
      imagesRef.current = next;
      // Prefer moving focus to the chip at the same index, else previous.
      const candidate = next[idx] ?? next[idx - 1];
      nextFocusId = candidate?.id ?? null;
      return next;
    });
    return { nextFocusId };
  }, []);

  const clear = useCallback(() => {
    setImages((prev) => {
      for (const img of prev) {
        try {
          URL.revokeObjectURL(img.previewUrl);
        } catch {
          // revoke is best-effort
        }
      }
      imagesRef.current = [];
      return [];
    });
  }, []);

  // Final safety net: revoke any outstanding blob URLs on unmount. Safe
  // under StrictMode double-invoke because revoked blob URLs are only
  // referenced from in-hook chip state, which is rebuilt on remount.
  useEffect(() => {
    return () => {
      for (const img of imagesRef.current) {
        try {
          URL.revokeObjectURL(img.previewUrl);
        } catch {
          // best-effort cleanup on unmount
        }
      }
    };
  }, []);

  const encoding = images.some((img) => img.status === "encoding");
  const full = images.length >= MAX_IMAGES_PER_MESSAGE;

  return { images, enqueue, remove, clear, encoding, full };
}
