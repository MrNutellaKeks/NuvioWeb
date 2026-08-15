import { requestWebOsCompanionService } from "../../platform/webos/webosCompanionService.js";

const REQUEST_TIMEOUT_MS = 30000;
const WINDOW_REQUEST_TIMEOUT_MS = 60000;
const preparedSources = new Map();
const MAX_PREPARED_SOURCES = 4;

function withTimeout(promise, timeoutMs) {
  let timeoutId = 0;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error("webOS bitmap subtitle request timed out")),
      timeoutMs
    );
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeoutId));
}

function decodeBase64(value) {
  const binary = globalThis.atob(String(value || ""));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function getRequestErrorMessage(error, fallback) {
  return String(error?.errorText || error?.message || error?.errorCode || fallback);
}

export const localMediaBitmapSubtitleRepository = {
  async prepare(url) {
    const targetUrl = String(url || "").trim();
    if (!/^https?:\/\//i.test(targetUrl)) {
      throw new Error("Invalid embedded bitmap subtitle source");
    }
    if (preparedSources.has(targetUrl)) {
      return preparedSources.get(targetUrl);
    }
    const request = withTimeout(
      requestWebOsCompanionService({
        method: "bitmapSubtitlePrepare",
        parameters: { url: targetUrl }
      }),
      REQUEST_TIMEOUT_MS
    )
      .then((result) => {
        const payload = result?.payload || {};
        if (payload.returnValue === false) {
          throw new Error(
            payload.errorText || payload.errorCode || "Bitmap subtitle preparation failed"
          );
        }
        return payload;
      })
      .catch((error) => {
        preparedSources.delete(targetUrl);
        throw error;
      });
    preparedSources.set(targetUrl, request);
    while (preparedSources.size > MAX_PREPARED_SOURCES) {
      preparedSources.delete(preparedSources.keys().next().value);
    }
    return request;
  },

  async getWindow({ url, trackNumber, startSeconds, endSeconds }) {
    const targetUrl = String(url || "").trim();
    const targetTrack = Math.trunc(Number(trackNumber));
    if (!/^https?:\/\//i.test(targetUrl) || !Number.isFinite(targetTrack) || targetTrack <= 0) {
      throw new Error("Invalid embedded bitmap subtitle request");
    }

    let result;
    try {
      result = await withTimeout(
        requestWebOsCompanionService({
          method: "bitmapSubtitleWindow",
          parameters: {
            url: targetUrl,
            trackNumber: targetTrack,
            startSeconds: Math.max(0, Number(startSeconds) || 0),
            endSeconds: Math.max(1, Number(endSeconds) || 0)
          }
        }),
        WINDOW_REQUEST_TIMEOUT_MS
      );
    } catch (error) {
      throw new Error(getRequestErrorMessage(error, "Bitmap subtitle extraction failed"));
    }
    const payload = result?.payload || {};
    if (payload.returnValue === false) {
      throw new Error(
        payload.errorText || payload.errorCode || "Bitmap subtitle extraction failed"
      );
    }
    const format = String(payload.format || "").toLowerCase();
    if (format !== "vobsub" && format !== "pgs") {
      throw new Error("Unsupported bitmap subtitle response");
    }
    const encodedData = format === "pgs" ? payload.supBase64 : payload.subBase64;

    return {
      format,
      trackNumber: targetTrack,
      windowStartSeconds: Math.max(0, Number(payload.windowStartSeconds) || 0),
      windowEndSeconds: Math.max(0, Number(payload.windowEndSeconds) || 0),
      contextStartSeconds: Math.max(0, Number(payload.contextStartSeconds) || 0),
      contextType: String(payload.contextType || ""),
      cueCount: Math.max(0, Math.trunc(Number(payload.cueCount) || 0)),
      segmentCount: Math.max(0, Math.trunc(Number(payload.segmentCount) || 0)),
      idxContent: format === "vobsub" ? String(payload.idxContent || "") : "",
      data: decodeBase64(encodedData)
    };
  }
};
