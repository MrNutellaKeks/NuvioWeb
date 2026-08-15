export const CLOUD_LIBRARY_ITEM_TYPES = {
  TORRENT: "Torrent",
  USENET: "Usenet",
  WEB_DOWNLOAD: "WebDownload",
  FILE: "File"
};

const PLAYABLE_VIDEO_EXTENSIONS = new Set([
  "3g2",
  "3gp",
  "avi",
  "divx",
  "flv",
  "m2ts",
  "m4v",
  "mkv",
  "mov",
  "mp4",
  "mpeg",
  "mpg",
  "mts",
  "ogm",
  "ogv",
  "ts",
  "webm",
  "wmv"
]);

function firstNonBlank(values = []) {
  return values.map((value) => String(value ?? "").trim()).find(Boolean) || null;
}

function scalarString(value) {
  if (["string", "number", "boolean"].includes(typeof value)) {
    return String(value).trim() || null;
  }
  return null;
}

function pathBasename(value = "") {
  return String(value).split(/[\\/]/).pop() || "";
}

function normalizeDisplayName(value = "") {
  return pathBasename(value)
    .replace(/\.[^.]+$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function isPlayableCloudFile(name = "", mimeType = "") {
  const mime = String(mimeType || "").toLowerCase();
  if (mime.startsWith("video/")) return true;
  const extension = String(name || "")
    .split(".")
    .pop()
    .toLowerCase();
  return PLAYABLE_VIDEO_EXTENSIONS.has(extension);
}

function torboxFileName(file = {}, parentName = "") {
  const rawName = String(file.name || "").trim();
  const shortName = String(file.short_name || "").trim();
  const absolutePath = String(file.absolute_path || "").trim();
  const pathName = pathBasename(absolutePath);
  const rawBasename = /[\\/]/.test(rawName) ? pathBasename(rawName) : "";
  const candidates = [
    shortName,
    rawBasename,
    /[\\/]/.test(rawName) ? "" : rawName,
    pathName,
    rawName,
    absolutePath
  ].filter(Boolean);
  return (
    candidates.find((candidate) => {
      if (normalizeDisplayName(candidate) === normalizeDisplayName(parentName)) return false;
      const pathWithoutExtension = pathName.replace(/\.[^.]+$/, "");
      return (
        candidate.includes(".") ||
        normalizeDisplayName(candidate) !== normalizeDisplayName(pathWithoutExtension)
      );
    }) ||
    candidates[0] ||
    null
  );
}

export function mapTorboxCloudItems(
  rows = [],
  { providerId = "torbox", providerName = "Torbox", type = CLOUD_LIBRARY_ITEM_TYPES.TORRENT } = {}
) {
  return (Array.isArray(rows) ? rows : []).flatMap((row) => {
    const id = scalarString(row?.id) || firstNonBlank([row?.hash]);
    if (!id) return [];
    const name = firstNonBlank([row?.name]) || id;
    const files = (Array.isArray(row?.files) ? row.files : []).flatMap((file) => {
      const fileName = torboxFileName(file, name);
      if (!fileName) return [];
      const fileId = scalarString(file?.id);
      const mimeType = firstNonBlank([file?.mimetype, file?.mime_type]);
      return [
        {
          id: fileId,
          name: fileName,
          sizeBytes: Number.isFinite(Number(file?.size)) ? Number(file.size) : null,
          mimeType,
          playable: Boolean(fileId && isPlayableCloudFile(fileName, mimeType)),
          playbackUrl: null,
          stableKey: fileId || fileName
        }
      ];
    });
    const fileSize = files.reduce((total, file) => total + (Number(file.sizeBytes) || 0), 0);
    const progressValue = [row?.progress, row?.download_progress].find((value) =>
      Number.isFinite(Number(value))
    );
    const rawProgress = Number(progressValue);
    const itemSize = [row?.size, row?.total_size].find((value) => Number.isFinite(Number(value)));
    return [
      {
        providerId,
        providerName,
        id,
        type,
        name,
        status: firstNonBlank([row?.status, row?.download_state, row?.state]),
        sizeBytes: itemSize != null ? Number(itemSize) : fileSize || null,
        progressFraction: Number.isFinite(rawProgress)
          ? Math.max(0, Math.min(1, rawProgress > 1 ? rawProgress / 100 : rawProgress))
          : null,
        files,
        stableKey: `${providerId}:${type}:${id}`
      }
    ];
  });
}

export function mapPremiumizeCloudItems(
  rows = [],
  { providerId = "premiumize", providerName = "Premiumize" } = {}
) {
  const groups = new Map();
  (Array.isArray(rows) ? rows : []).forEach((row) => {
    const normalizedPath = String(row?.path || "")
      .trim()
      .replace(/^\/+|\/+$/g, "");
    const name = firstNonBlank([row?.name, pathBasename(normalizedPath)]);
    if (!name) return;
    const id = firstNonBlank([row?.id]);
    const segments = normalizedPath
      .split("/")
      .map((part) => part.trim())
      .filter(Boolean);
    const rootFile = segments.length <= 1;
    const itemName = rootFile ? name : segments[0] || name;
    const itemId = rootFile
      ? `file:${id || normalizedPath || name}`
      : `folder:${segments[0] || itemName}`;
    const mimeType = firstNonBlank([row?.mime_type]);
    const playable = isPlayableCloudFile(name, mimeType);
    const file = {
      id,
      name,
      sizeBytes: Number.isFinite(Number(row?.size)) ? Number(row.size) : null,
      mimeType,
      playable,
      playbackUrl: playable ? firstNonBlank([row?.link]) : null,
      stableKey: id || name
    };
    if (!groups.has(itemId)) groups.set(itemId, { itemId, itemName, files: [] });
    groups.get(itemId).files.push(file);
  });
  return [...groups.values()]
    .map((group) => {
      const files = group.files.sort(
        (left, right) =>
          Number(!left.playable) - Number(!right.playable) || left.name.localeCompare(right.name)
      );
      const sizeBytes =
        files.reduce((total, file) => total + (Number(file.sizeBytes) || 0), 0) || null;
      return {
        providerId,
        providerName,
        id: group.itemId,
        type: CLOUD_LIBRARY_ITEM_TYPES.FILE,
        name: group.itemName,
        status: "Ready",
        sizeBytes,
        progressFraction: null,
        files,
        stableKey: `${providerId}:${CLOUD_LIBRARY_ITEM_TYPES.FILE}:${group.itemId}`
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function playableCloudFiles(item = {}) {
  return (Array.isArray(item.files) ? item.files : []).filter((file) => file.playable);
}
