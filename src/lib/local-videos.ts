// Browser-local artifact storage (IndexedDB) for uploaded videos and replay.
// Keeps the Convex database free of large blobs while the owner's session can
// still play the exact uploaded files in the synchronized timeline.

const DB_NAME = "contexttrace-videos";
const STORE = "files";
const VERSION = 1;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function putVideo(key: string, file: File): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(file, key);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

export async function getVideo(key: string): Promise<File | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => {
      db.close();
      resolve((req.result as File | undefined) ?? null);
    };
    req.onerror = () => {
      db.close();
      reject(req.error);
    };
  });
}

export async function deleteVideo(key: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(key);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

// ---------------------------------------------------------------------------
// Client-side media validation (mirrors the pipeline's server-side re-checks)
// ---------------------------------------------------------------------------

export const ACCEPTED_TYPES = [
  "video/mp4",
  "video/quicktime",
  "video/webm",
  "video/x-matroska",
  "video/x-msvideo",
  "video/x-m4v",
];

export const ACCEPTED_EXTENSIONS = /\.(mp4|mov|webm|mkv|avi|m4v)$/i;
export const MAX_FILE_BYTES = 500 * 1024 * 1024;

export type LocalValidationResult =
  | {
      ok: true;
      filename: string;
      mimeType: string;
      byteSize: number;
      durationSeconds: number;
      width: number;
      height: number;
      hasAudio: boolean;
      storageKey: string;
    }
  | { ok: false; error: string };

/**
 * Validate a video file fully client-side: container/extension, size, then a
 * real decode probe via a detached <video> element (duration + audio track
 * presence). Returns a storage key only after the file passes.
 */
export async function validateAndStore(file: File): Promise<LocalValidationResult> {
  if (!ACCEPTED_EXTENSIONS.test(file.name)) {
    return {
      ok: false,
      error:
        "Unsupported format. Accepted containers: mp4, mov, webm, mkv, avi, m4v.",
    };
  }
  if (file.size > MAX_FILE_BYTES) {
    return { ok: false, error: "File exceeds the 500 MB limit." };
  }
  if (file.size === 0) {
    return { ok: false, error: "File is empty (0 bytes)." };
  }

  const probe = await probeVideo(file);
  if (!probe.ok) return probe;

  const storageKey = `ct_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  try {
    await putVideo(storageKey, file);
  } catch (e) {
    return {
      ok: false,
      error:
        e instanceof Error
          ? `Local storage failed: ${e.message}`
          : "Local storage failed.",
    };
  }

  return { ok: true, ...probe.value, storageKey };
}

function probeVideo(
  file: File,
): Promise<
  | { ok: true; value: {
      filename: string;
      mimeType: string;
      byteSize: number;
      durationSeconds: number;
      width: number;
      height: number;
      hasAudio: boolean;
    } }
  | { ok: false; error: string }
> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.preload = "metadata";
    video.muted = true;

    const cleanup = () => {
      URL.revokeObjectURL(url);
      video.removeAttribute("src");
      video.load();
    };

    const timeout = window.setTimeout(() => {
      cleanup();
      resolve({
        ok: false,
        error: "Timed out reading media metadata. The file may be corrupt or an unsupported codec.",
      });
    }, 15000);

    video.onloadedmetadata = () => {
      window.clearTimeout(timeout);
      const duration = video.duration;
      if (!Number.isFinite(duration) || duration <= 0) {
        cleanup();
        resolve({
          ok: false,
          error: "Media duration could not be read. The file may be corrupt or unsupported.",
        });
        return;
      }
      // Detect audio: try WebAudio decode of a short slice is expensive; the
      // pragmatic signal is `webkitAudioDecodedByteCount`/`mozHasAudio` when
      // available, otherwise assume audio present (pipeline marks degraded if
      // ASR yields nothing).
      const w = video as HTMLVideoElement & {
        webkitAudioDecodedByteCount?: number;
        mozHasAudio?: boolean;
      };
      const hasAudio =
        typeof w.mozHasAudio === "boolean"
          ? w.mozHasAudio
          : typeof w.webkitAudioDecodedByteCount === "number"
            ? w.webkitAudioDecodedByteCount > 0
            : true;
      const result = {
        filename: file.name,
        mimeType: file.type || "video/mp4",
        byteSize: file.size,
        durationSeconds: Number(duration.toFixed(2)),
        width: video.videoWidth || 0,
        height: video.videoHeight || 0,
        hasAudio,
      };
      cleanup();
      resolve({ ok: true, value: result });
    };

    video.onerror = () => {
      window.clearTimeout(timeout);
      cleanup();
      resolve({
        ok: false,
        error: "The browser could not decode this file. It may be corrupt, or use an unsupported codec.",
      });
    };

    video.src = url;
  });
}
