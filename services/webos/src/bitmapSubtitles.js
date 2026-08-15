var http = require("http");
var https = require("https");
var zlib = require("zlib");

var HEADER_PROBE_BYTES = 2 * 1024 * 1024;
var CUES_PROBE_BYTES = 64 * 1024;
var MAX_CUES_BYTES = 8 * 1024 * 1024;
var MAX_CLUSTER_BYTES = 20 * 1024 * 1024;
var MAX_WINDOW_BYTES = 3 * 1024 * 1024;
var MAX_BLOCK_BYTES = 1024 * 1024;
var CUED_BLOCK_PROBE_BYTES = 64 * 1024;
var MAX_CUED_BLOCK_ELEMENT_BYTES = MAX_BLOCK_BYTES + 64 * 1024;
var MIN_CLUSTER_HEADER_BYTES = 5;
var MAX_CLUSTER_HEADER_BYTES = 12;
var MAX_REDIRECTS = 4;
var REQUEST_TIMEOUT_MS = 15000;
var METADATA_CACHE_TTL_MS = 10 * 60 * 1000;
var WINDOW_CACHE_TTL_MS = 5 * 60 * 1000;
var MAX_METADATA_CACHE_ENTRIES = 6;
var MAX_WINDOW_CACHE_ENTRIES = 12;
var WINDOW_BUCKET_SECONDS = 90;
var WINDOW_END_QUANTUM_SECONDS = 30;
var MIN_WINDOW_SECONDS = 120;
var MAX_WINDOW_SECONDS = 270;
var MAX_CONCURRENT_CLUSTER_REQUESTS = 3;
var MAX_CONCURRENT_CUED_BLOCK_REQUESTS = 6;
var PGS_SYNC_SCAN_BATCH_CUES = 8;
var PGS_MAX_SYNC_SCAN_CUES = 96;
var PGS_MAX_SYNC_LOOKBACK_MS = 15 * 60 * 1000;

var BITMAP_SUBTITLE_FORMAT_BY_CODEC_ID = {
  S_VOBSUB: "vobsub",
  "S_HDMV/PGS": "pgs"
};

var ID_SEGMENT = 0x18538067;
var ID_SEEK_HEAD = 0x114d9b74;
var ID_SEEK = 0x4dbb;
var ID_SEEK_ID = 0x53ab;
var ID_SEEK_POSITION = 0x53ac;
var ID_INFO = 0x1549a966;
var ID_TIMECODE_SCALE = 0x2ad7b1;
var ID_TRACKS = 0x1654ae6b;
var ID_TRACK_ENTRY = 0xae;
var ID_TRACK_NUMBER = 0xd7;
var ID_TRACK_TYPE = 0x83;
var ID_CODEC_ID = 0x86;
var ID_CODEC_PRIVATE = 0x63a2;
var ID_LANGUAGE = 0x22b59c;
var ID_LANGUAGE_IETF = 0x22b59d;
var ID_NAME = 0x536e;
var ID_CONTENT_ENCODINGS = 0x6d80;
var ID_CONTENT_ENCODING = 0x6240;
var ID_CONTENT_COMPRESSION = 0x5034;
var ID_CONTENT_COMP_ALGO = 0x4254;
var ID_CONTENT_COMP_SETTINGS = 0x4255;
var ID_CUES = 0x1c53bb6b;
var ID_CUE_POINT = 0xbb;
var ID_CUE_TIME = 0xb3;
var ID_CUE_TRACK_POSITIONS = 0xb7;
var ID_CUE_TRACK = 0xf7;
var ID_CUE_CLUSTER_POSITION = 0xf1;
var ID_CUE_RELATIVE_POSITION = 0xf0;
var ID_CLUSTER = 0x1f43b675;
var ID_CLUSTER_TIMECODE = 0xe7;
var ID_SIMPLE_BLOCK = 0xa3;
var ID_BLOCK_GROUP = 0xa0;
var ID_BLOCK = 0xa1;

var PGS_SEGMENT_PRESENTATION_COMPOSITION = 0x16;
var PGS_COMPOSITION_STATE_EPOCH_START = 0x80;
var PGS_COMPOSITION_STATE_ACQUISITION_POINT = 0x40;
var PGS_TIMESTAMP_WRAP = 0x100000000;

var MPEG_PACK_HEADER = Buffer.from([
  0x00, 0x00, 0x01, 0xba, 0x44, 0x00, 0x04, 0x00, 0x04, 0x01, 0x00, 0x00, 0x03, 0xf8
]);

var metadataCache = new Map();
var metadataRequests = new Map();
var windowCache = new Map();
var windowRequests = new Map();
var clusterRangeRequests = new Map();
var activePgsWindowRequests = new Map();

function bitmapSubtitleError(code, message, details) {
  var error = new Error(message);
  error.code = code;
  error.details = details || null;
  return error;
}

function normalizeMediaUrl(value) {
  var text = String(value || "").trim();
  var parsed;
  try {
    parsed = new URL(text);
  } catch (_) {
    throw bitmapSubtitleError("INVALID_URL", "Bitmap subtitle source URL is invalid");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw bitmapSubtitleError("INVALID_URL", "Bitmap subtitle source must use HTTP or HTTPS");
  }
  return parsed.href;
}

function trimCache(cache, maxEntries) {
  while (cache.size > maxEntries) {
    cache.delete(cache.keys().next().value);
  }
}

function getCached(cache, key) {
  var entry = cache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }
  cache.delete(key);
  cache.set(key, entry);
  return entry.value;
}

function setCached(cache, key, value, ttlMs, maxEntries) {
  cache.delete(key);
  cache.set(key, { value: value, expiresAt: Date.now() + ttlMs });
  trimCache(cache, maxEntries);
}

function requestRange(url, start, end, maxBytes, redirects, requestContext) {
  var redirectCount = Number(redirects || 0);
  return new Promise(function (resolve, reject) {
    if (requestContext && requestContext.cancelled) {
      reject(bitmapSubtitleError("REQUEST_SUPERSEDED", "Bitmap subtitle request was superseded"));
      return;
    }
    var parsed;
    try {
      parsed = new URL(url);
    } catch (_) {
      reject(bitmapSubtitleError("INVALID_URL", "Invalid bitmap subtitle range URL"));
      return;
    }

    var transport = parsed.protocol === "https:" ? https : http;
    var req = transport.request(
      parsed,
      {
        method: "GET",
        headers: {
          Range: "bytes=" + start + "-" + end,
          "Accept-Encoding": "identity",
          "User-Agent": "NuvioTV-Web/bitmap-subtitles"
        }
      },
      function (res) {
        var statusCode = Number(res.statusCode || 0);
        if (statusCode >= 300 && statusCode < 400 && res.headers.location) {
          res.resume();
          if (requestContext) requestContext.requests.delete(req);
          if (redirectCount >= MAX_REDIRECTS) {
            reject(
              bitmapSubtitleError(
                "TOO_MANY_REDIRECTS",
                "Bitmap subtitle source redirected too many times"
              )
            );
            return;
          }
          var redirected = new URL(res.headers.location, parsed).href;
          requestRange(redirected, start, end, maxBytes, redirectCount + 1, requestContext).then(
            resolve,
            reject
          );
          return;
        }

        if (statusCode !== 206 && !(statusCode === 200 && start === 0)) {
          res.resume();
          if (requestContext) requestContext.requests.delete(req);
          reject(
            bitmapSubtitleError(
              "RANGE_UNAVAILABLE",
              "Bitmap subtitle source did not honor HTTP Range",
              { statusCode: statusCode }
            )
          );
          return;
        }

        var chunks = [];
        var received = 0;
        res.on("data", function (chunk) {
          received += chunk.length;
          if (received > maxBytes) {
            req.destroy(
              bitmapSubtitleError(
                "RANGE_TOO_LARGE",
                "Bitmap subtitle range exceeded its safety limit"
              )
            );
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", function () {
          var totalSize = null;
          var contentRange = String(res.headers["content-range"] || "");
          var rangeMatch = contentRange.match(/bytes\s+\d+-\d+\/(\d+|\*)/i);
          if (rangeMatch && rangeMatch[1] !== "*") {
            totalSize = Number(rangeMatch[1]);
          } else if (statusCode === 200) {
            totalSize = Number(res.headers["content-length"] || 0) || null;
          }
          if (requestContext) requestContext.requests.delete(req);
          resolve({
            buffer: Buffer.concat(chunks),
            totalSize: totalSize,
            finalUrl: parsed.href,
            statusCode: statusCode
          });
        });
      }
    );

    if (requestContext) requestContext.requests.add(req);

    req.setTimeout(REQUEST_TIMEOUT_MS, function () {
      req.destroy(bitmapSubtitleError("RANGE_TIMEOUT", "Bitmap subtitle range request timed out"));
    });
    req.on("error", function (error) {
      if (requestContext) requestContext.requests.delete(req);
      reject(error);
    });
    req.end();
  });
}

function vintWidth(firstByte) {
  if (!firstByte) return 0;
  for (var width = 1; width <= 8; width += 1) {
    if (firstByte & (1 << (8 - width))) return width;
  }
  return 0;
}

function readElementId(data, offset) {
  var first = data[offset];
  var width = vintWidth(first);
  if (!width || width > 4 || offset + width > data.length) return null;
  var value = first;
  for (var index = 1; index < width; index += 1) {
    value = value * 256 + data[offset + index];
  }
  return { value: value >>> 0, width: width };
}

function readVint(data, offset) {
  var first = data[offset];
  var width = vintWidth(first);
  if (!width || offset + width > data.length) return null;
  var marker = 1 << (8 - width);
  var value = first & (marker - 1);
  for (var index = 1; index < width; index += 1) {
    value = value * 256 + data[offset + index];
  }
  return { value: value, width: width };
}

function readElement(data, offset, limit, allowTruncated) {
  var id = readElementId(data, offset);
  if (!id) return null;
  var size = readVint(data, offset + id.width);
  if (!size) return null;
  var unknown = size.value === Math.pow(2, size.width * 7) - 1;
  var dataStart = offset + id.width + size.width;
  var dataEnd = unknown ? limit : dataStart + size.value;
  if (dataStart > limit || (!allowTruncated && dataEnd > limit)) return null;
  return {
    id: id.value,
    start: offset,
    dataStart: dataStart,
    dataEnd: Math.min(dataEnd, limit),
    declaredDataEnd: dataEnd,
    totalSize: unknown ? null : dataEnd - offset,
    truncated: dataEnd > limit,
    unknownSize: unknown
  };
}

function childElements(data, start, end) {
  var items = [];
  var offset = start;
  while (offset < end) {
    var element = readElement(data, offset, end, false);
    if (!element || element.declaredDataEnd <= offset) break;
    items.push(element);
    offset = element.declaredDataEnd;
  }
  return items;
}

function findChild(data, parent, id) {
  var children = childElements(data, parent.dataStart, parent.dataEnd);
  for (var index = 0; index < children.length; index += 1) {
    if (children[index].id === id) return children[index];
  }
  return null;
}

function readUnsigned(data, element) {
  if (!element) return null;
  var size = element.dataEnd - element.dataStart;
  if (size <= 0 || size > 8) return null;
  var value = 0;
  for (var index = element.dataStart; index < element.dataEnd; index += 1) {
    value = value * 256 + data[index];
  }
  return value;
}

function readString(data, element) {
  if (!element) return "";
  return data
    .slice(element.dataStart, element.dataEnd)
    .toString("utf8")
    .replace(/\0+$/g, "")
    .trim();
}

function readBinaryId(data, element) {
  if (!element) return null;
  var value = 0;
  for (var index = element.dataStart; index < element.dataEnd; index += 1) {
    value = value * 256 + data[index];
  }
  return value >>> 0;
}

function parseCompression(data, trackEntry) {
  var encodings = findChild(data, trackEntry, ID_CONTENT_ENCODINGS);
  if (!encodings) return { type: "none", settings: Buffer.alloc(0) };
  var encoding = findChild(data, encodings, ID_CONTENT_ENCODING);
  var compression = encoding ? findChild(data, encoding, ID_CONTENT_COMPRESSION) : null;
  if (!compression) return { type: "none", settings: Buffer.alloc(0) };
  var algo = readUnsigned(data, findChild(data, compression, ID_CONTENT_COMP_ALGO));
  var settingsElement = findChild(data, compression, ID_CONTENT_COMP_SETTINGS);
  var settings = settingsElement
    ? Buffer.from(data.slice(settingsElement.dataStart, settingsElement.dataEnd))
    : Buffer.alloc(0);
  if (algo == null || algo === 0) return { type: "zlib", settings: settings };
  if (algo === 3) return { type: "header", settings: settings };
  return { type: "unsupported", algorithm: algo, settings: settings };
}

function parseTracks(data, tracksElement) {
  return childElements(data, tracksElement.dataStart, tracksElement.dataEnd)
    .filter(function (entry) {
      return entry.id === ID_TRACK_ENTRY;
    })
    .map(function (entry) {
      var codecPrivate = findChild(data, entry, ID_CODEC_PRIVATE);
      return {
        number: readUnsigned(data, findChild(data, entry, ID_TRACK_NUMBER)),
        type: readUnsigned(data, findChild(data, entry, ID_TRACK_TYPE)),
        codecId: readString(data, findChild(data, entry, ID_CODEC_ID)),
        language:
          readString(data, findChild(data, entry, ID_LANGUAGE_IETF)) ||
          readString(data, findChild(data, entry, ID_LANGUAGE)),
        name: readString(data, findChild(data, entry, ID_NAME)),
        codecPrivate: codecPrivate
          ? Buffer.from(data.slice(codecPrivate.dataStart, codecPrivate.dataEnd))
          : Buffer.alloc(0),
        compression: parseCompression(data, entry)
      };
    });
}

function parseHeader(data, totalSize) {
  var offset = 0;
  var segment = null;
  while (offset < data.length) {
    var top = readElement(data, offset, data.length, true);
    if (!top) break;
    if (top.id === ID_SEGMENT) {
      segment = top;
      break;
    }
    if (top.truncated) break;
    offset = top.declaredDataEnd;
  }
  if (!segment) throw bitmapSubtitleError("INVALID_MATROSKA", "Matroska Segment was not found");

  var seekPositions = {};
  var timecodeScaleNs = 1000000;
  var tracks = [];
  var childOffset = segment.dataStart;
  while (childOffset < data.length) {
    var child = readElement(data, childOffset, data.length, true);
    if (!child || child.truncated) break;
    if (child.id === ID_SEEK_HEAD) {
      childElements(data, child.dataStart, child.dataEnd).forEach(function (seek) {
        if (seek.id !== ID_SEEK) return;
        var targetId = readBinaryId(data, findChild(data, seek, ID_SEEK_ID));
        var position = readUnsigned(data, findChild(data, seek, ID_SEEK_POSITION));
        if (targetId != null && position != null) seekPositions[targetId] = position;
      });
    } else if (child.id === ID_INFO) {
      var scale = readUnsigned(data, findChild(data, child, ID_TIMECODE_SCALE));
      if (scale) timecodeScaleNs = scale;
    } else if (child.id === ID_TRACKS) {
      tracks = parseTracks(data, child);
    }
    childOffset = child.declaredDataEnd;
  }

  if (!tracks.length)
    throw bitmapSubtitleError(
      "TRACKS_NOT_FOUND",
      "Matroska tracks were not found in the header probe"
    );
  if (seekPositions[ID_CUES] == null)
    throw bitmapSubtitleError("CUES_NOT_FOUND", "Matroska SeekHead does not reference Cues");
  return {
    totalSize: totalSize,
    segmentDataStart: segment.dataStart,
    segmentDataEnd:
      segment.totalSize == null ? totalSize : Math.min(totalSize, segment.declaredDataEnd),
    cuesOffset: segment.dataStart + seekPositions[ID_CUES],
    timecodeScaleNs: timecodeScaleNs,
    tracks: tracks
  };
}

function parseCues(data, timecodeScaleNs) {
  var cuesElement = readElement(data, 0, data.length, false);
  if (!cuesElement || cuesElement.id !== ID_CUES) {
    throw bitmapSubtitleError("INVALID_CUES", "Matroska Cues element is invalid or truncated");
  }
  var cues = [];
  childElements(data, cuesElement.dataStart, cuesElement.dataEnd).forEach(function (point) {
    if (point.id !== ID_CUE_POINT) return;
    var cueTicks = readUnsigned(data, findChild(data, point, ID_CUE_TIME));
    if (cueTicks == null) return;
    var timeMs = (cueTicks * timecodeScaleNs) / 1000000;
    childElements(data, point.dataStart, point.dataEnd).forEach(function (position) {
      if (position.id !== ID_CUE_TRACK_POSITIONS) return;
      var track = readUnsigned(data, findChild(data, position, ID_CUE_TRACK));
      var clusterPosition = readUnsigned(data, findChild(data, position, ID_CUE_CLUSTER_POSITION));
      var relativePosition = readUnsigned(
        data,
        findChild(data, position, ID_CUE_RELATIVE_POSITION)
      );
      if (track == null || clusterPosition == null) return;
      cues.push({
        timeMs: timeMs,
        timeTicks: cueTicks,
        track: track,
        clusterPosition: clusterPosition,
        relativePosition: relativePosition
      });
    });
  });
  cues.sort(function (left, right) {
    return (
      left.timeMs - right.timeMs ||
      left.clusterPosition - right.clusterPosition ||
      Number(left.relativePosition || 0) - Number(right.relativePosition || 0) ||
      left.track - right.track
    );
  });
  if (!cues.length)
    throw bitmapSubtitleError("EMPTY_CUES", "Matroska Cues did not contain usable positions");
  return cues;
}

async function loadMetadata(mediaUrl) {
  var cached = getCached(metadataCache, mediaUrl);
  if (cached) return cached;
  if (metadataRequests.has(mediaUrl)) return metadataRequests.get(mediaUrl);

  var request = (async function () {
    var head = await requestRange(mediaUrl, 0, HEADER_PROBE_BYTES - 1, HEADER_PROBE_BYTES);
    if (!head.totalSize)
      throw bitmapSubtitleError("SIZE_UNKNOWN", "Bitmap subtitle source size is unknown");
    var metadata = parseHeader(head.buffer, head.totalSize);
    var cuesProbeEnd = Math.min(metadata.totalSize - 1, metadata.cuesOffset + CUES_PROBE_BYTES - 1);
    var cuesProbe = await requestRange(
      mediaUrl,
      metadata.cuesOffset,
      cuesProbeEnd,
      CUES_PROBE_BYTES
    );
    var cuesHeader = readElement(cuesProbe.buffer, 0, cuesProbe.buffer.length, true);
    if (!cuesHeader || cuesHeader.id !== ID_CUES || cuesHeader.totalSize == null) {
      throw bitmapSubtitleError("INVALID_CUES", "Matroska Cues size could not be determined");
    }
    if (cuesHeader.totalSize > MAX_CUES_BYTES) {
      throw bitmapSubtitleError(
        "CUES_TOO_LARGE",
        "Matroska Cues exceed the supported safety limit"
      );
    }
    var cuesBuffer = cuesProbe.buffer;
    if (cuesBuffer.length < cuesHeader.totalSize) {
      cuesBuffer = (
        await requestRange(
          mediaUrl,
          metadata.cuesOffset,
          metadata.cuesOffset + cuesHeader.totalSize - 1,
          MAX_CUES_BYTES
        )
      ).buffer;
    }
    metadata.cues = parseCues(cuesBuffer, metadata.timecodeScaleNs);
    metadata.clusterPositions = Array.from(
      new Set(
        metadata.cues.map(function (cue) {
          return cue.clusterPosition;
        })
      )
    ).sort(function (a, b) {
      return a - b;
    });
    setCached(metadataCache, mediaUrl, metadata, METADATA_CACHE_TTL_MS, MAX_METADATA_CACHE_ENTRIES);
    return metadata;
  })();

  metadataRequests.set(mediaUrl, request);
  try {
    return await request;
  } finally {
    metadataRequests.delete(mediaUrl);
  }
}

function decodeBlockPayload(payload, compression) {
  if (!compression || compression.type === "none") return payload;
  if (compression.type === "header") return Buffer.concat([compression.settings, payload]);
  if (compression.type === "zlib") {
    var inflated = zlib.inflateSync(payload, { maxOutputLength: MAX_BLOCK_BYTES });
    if (inflated.length > MAX_BLOCK_BYTES) {
      throw bitmapSubtitleError(
        "BLOCK_TOO_LARGE",
        "Inflated bitmap subtitle block exceeded its safety limit"
      );
    }
    return inflated;
  }
  throw bitmapSubtitleError(
    "UNSUPPORTED_COMPRESSION",
    "Unsupported Matroska subtitle compression",
    {
      algorithm: compression.algorithm
    }
  );
}

function getBitmapSubtitleFormat(track) {
  return BITMAP_SUBTITLE_FORMAT_BY_CODEC_ID[String((track && track.codecId) || "")] || null;
}

function isBitmapSubtitleTrack(track) {
  return Boolean(track && track.type === 0x11 && getBitmapSubtitleFormat(track));
}

function validateVobSubPayload(payload) {
  if (!payload || payload.length < 4) return false;
  var packetSize = payload.readUInt16BE(0);
  var controlOffset = payload.readUInt16BE(2);
  return packetSize === payload.length && controlOffset >= 4 && controlOffset <= packetSize;
}

function parseBlock(data, element, track, clusterTicks, timecodeScaleNs, blockOrder) {
  var raw = data.slice(element.dataStart, element.dataEnd);
  var trackVint = readVint(raw, 0);
  if (!trackVint || trackVint.value !== track.number || raw.length < trackVint.width + 3)
    return null;
  var relativeTicks = raw.readInt16BE(trackVint.width);
  var flags = raw[trackVint.width + 2];
  if ((flags & 0x06) !== 0) {
    throw bitmapSubtitleError(
      "LACED_BITMAP_SUBTITLE",
      "Laced Matroska bitmap subtitle blocks are not supported"
    );
  }
  var payload = decodeBlockPayload(raw.slice(trackVint.width + 3), track.compression);
  if (payload.length > MAX_BLOCK_BYTES) {
    throw bitmapSubtitleError("BLOCK_TOO_LARGE", "Bitmap subtitle block exceeded its safety limit");
  }
  var absoluteTicks = clusterTicks + relativeTicks;
  if (absoluteTicks < 0) return null;
  var timestampNs = absoluteTicks * timecodeScaleNs;
  return {
    timestampMs: timestampNs / 1000000,
    timestampNs: timestampNs,
    payload: payload,
    blockOrder: Number(blockOrder || 0)
  };
}

function parseCluster(data, track, timecodeScaleNs) {
  var cluster = readElement(data, 0, data.length, false);
  if (!cluster || cluster.id !== ID_CLUSTER) {
    throw bitmapSubtitleError("INVALID_CLUSTER", "Matroska cluster range is invalid or truncated");
  }
  var children = childElements(data, cluster.dataStart, cluster.dataEnd);
  var clusterTicks = 0;
  for (var index = 0; index < children.length; index += 1) {
    if (children[index].id === ID_CLUSTER_TIMECODE) {
      clusterTicks = readUnsigned(data, children[index]) || 0;
      break;
    }
  }
  var frames = [];
  children.forEach(function (child, childIndex) {
    var block = null;
    if (child.id === ID_SIMPLE_BLOCK) {
      block = child;
    } else if (child.id === ID_BLOCK_GROUP) {
      block = findChild(data, child, ID_BLOCK);
    }
    if (!block) return;
    var frame = parseBlock(data, block, track, clusterTicks, timecodeScaleNs, childIndex);
    if (frame) frames.push(frame);
  });
  return frames;
}

function nextClusterPosition(metadata, clusterPosition) {
  for (var index = 0; index < metadata.clusterPositions.length; index += 1) {
    if (metadata.clusterPositions[index] > clusterPosition) return metadata.clusterPositions[index];
  }
  return metadata.segmentDataEnd - metadata.segmentDataStart;
}

function selectClusterPositions(metadata, trackNumber, startMs, endMs) {
  var trackCues = metadata.cues.filter(function (cue) {
    return cue.track === trackNumber;
  });
  var selected = trackCues.filter(function (cue) {
    return cue.timeMs >= startMs && cue.timeMs <= endMs;
  });
  var previous = null;
  trackCues.forEach(function (cue) {
    if (cue.timeMs < startMs && (!previous || cue.timeMs > previous.timeMs)) previous = cue;
  });
  if (previous && startMs - previous.timeMs <= 30000) selected.unshift(previous);
  if (!selected.length) return [];
  return Array.from(
    new Set(
      selected.map(function (cue) {
        return cue.clusterPosition;
      })
    )
  ).sort(function (a, b) {
    return a - b;
  });
}

function getTrackCues(metadata, trackNumber) {
  var seenPositions = new Set();
  return metadata.cues.filter(function (cue) {
    var key =
      cue.relativePosition == null
        ? String(cue.clusterPosition)
        : cue.clusterPosition + ":" + cue.relativePosition;
    if (cue.track !== trackNumber || seenPositions.has(key)) return false;
    seenPositions.add(key);
    return true;
  });
}

function cuePositionKey(cue) {
  return cue.clusterPosition + ":" + cue.relativePosition;
}

function buildClusterRanges(metadata, positions) {
  return positions.map(function (clusterPosition) {
    var nextPosition = nextClusterPosition(metadata, clusterPosition);
    var clusterSize = nextPosition - clusterPosition;
    if (clusterSize <= 0 || clusterSize > MAX_CLUSTER_BYTES) {
      throw bitmapSubtitleError(
        "CLUSTER_TOO_LARGE",
        "Matroska subtitle cluster exceeded its safety limit",
        { clusterSize: clusterSize }
      );
    }
    return {
      clusterPosition: clusterPosition,
      absoluteStart: metadata.segmentDataStart + clusterPosition,
      clusterSize: clusterSize
    };
  });
}

async function loadClusterFrames(mediaUrl, metadata, track, positions) {
  var clusterRanges = buildClusterRanges(
    metadata,
    Array.from(new Set(positions)).sort(function (left, right) {
      return left - right;
    })
  );
  var clusterFrames = await mapWithConcurrency(
    clusterRanges,
    MAX_CONCURRENT_CLUSTER_REQUESTS,
    async function (range) {
      var response = await requestClusterRange(mediaUrl, range.absoluteStart, range.clusterSize);
      return parseCluster(response.buffer, track, metadata.timecodeScaleNs).map(function (frame) {
        return Object.assign(frame, { clusterPosition: range.clusterPosition });
      });
    }
  );
  var frames = [];
  clusterFrames.forEach(function (entries) {
    frames.push.apply(frames, entries);
  });
  frames.sort(compareFrames);
  return frames;
}

function invalidCuePosition(message, details) {
  return bitmapSubtitleError("INVALID_CUE_POSITION", message, details);
}

function getCuedBlockTrackNumber(data, element) {
  var block = element;
  if (element.id === ID_BLOCK_GROUP) {
    var childOffset = element.dataStart;
    block = null;
    while (childOffset < element.dataEnd) {
      var child = readElement(data, childOffset, element.dataEnd, true);
      if (!child) break;
      if (child.id === ID_BLOCK) {
        block = child;
        break;
      }
      if (child.truncated || child.declaredDataEnd <= childOffset) break;
      childOffset = child.declaredDataEnd;
    }
    if (!block) return null;
  }
  var trackVint = readVint(data, block.dataStart);
  return trackVint ? trackVint.value : null;
}

function findCuedBlockElement(data, track) {
  for (
    var offset = MIN_CLUSTER_HEADER_BYTES;
    offset <= MAX_CLUSTER_HEADER_BYTES && offset < data.length;
    offset += 1
  ) {
    var element = readElement(data, offset, data.length, true);
    if (
      element &&
      (element.id === ID_SIMPLE_BLOCK || element.id === ID_BLOCK_GROUP) &&
      element.totalSize != null &&
      getCuedBlockTrackNumber(data, element) === track.number
    ) {
      return element;
    }
  }
  return null;
}

function parseCuedBlock(data, element, track, cue, timecodeScaleNs) {
  var block = null;
  if (element.id === ID_SIMPLE_BLOCK) {
    block = element;
  } else if (element.id === ID_BLOCK_GROUP) {
    block = findChild(data, element, ID_BLOCK);
  }
  if (!block) {
    throw invalidCuePosition("CueRelativePosition did not reference a subtitle block", {
      clusterPosition: cue.clusterPosition,
      relativePosition: cue.relativePosition
    });
  }
  var raw = data.slice(block.dataStart, block.dataEnd);
  var trackVint = readVint(raw, 0);
  if (!trackVint || trackVint.value !== track.number || raw.length < trackVint.width + 3) {
    throw invalidCuePosition("CueRelativePosition referenced a different Matroska track", {
      clusterPosition: cue.clusterPosition,
      relativePosition: cue.relativePosition
    });
  }
  var flags = raw[trackVint.width + 2];
  if ((flags & 0x06) !== 0) {
    throw bitmapSubtitleError(
      "LACED_BITMAP_SUBTITLE",
      "Laced Matroska bitmap subtitle blocks are not supported"
    );
  }
  var payload = decodeBlockPayload(raw.slice(trackVint.width + 3), track.compression);
  if (payload.length > MAX_BLOCK_BYTES) {
    throw bitmapSubtitleError("BLOCK_TOO_LARGE", "Bitmap subtitle block exceeded its safety limit");
  }
  var timestampNs = cue.timeTicks * timecodeScaleNs;
  return {
    timestampMs: cue.timeMs,
    timestampNs: timestampNs,
    payload: payload,
    blockOrder: cue.relativePosition,
    clusterPosition: cue.clusterPosition
  };
}

async function loadCuedBlockFrame(mediaUrl, metadata, track, cue, requestContext) {
  if (cue.relativePosition == null || cue.relativePosition < 0) {
    throw invalidCuePosition("Cue has no usable CueRelativePosition", {
      clusterPosition: cue.clusterPosition
    });
  }
  var clusterEnd = metadata.segmentDataStart + nextClusterPosition(metadata, cue.clusterPosition);
  var probeStart = metadata.segmentDataStart + cue.clusterPosition + cue.relativePosition;
  var availableBytes = clusterEnd - probeStart;
  if (availableBytes <= 0) {
    throw invalidCuePosition("CueRelativePosition points outside its Cluster", {
      clusterPosition: cue.clusterPosition,
      relativePosition: cue.relativePosition
    });
  }
  var probeBytes = Math.min(CUED_BLOCK_PROBE_BYTES + MAX_CLUSTER_HEADER_BYTES, availableBytes);
  var response = await requestRange(
    mediaUrl,
    probeStart,
    probeStart + probeBytes - 1,
    CUED_BLOCK_PROBE_BYTES + MAX_CLUSTER_HEADER_BYTES,
    0,
    requestContext
  );
  var element = findCuedBlockElement(response.buffer, track);
  var absoluteStart = element ? probeStart + element.start : probeStart;
  var elementAvailableBytes = clusterEnd - absoluteStart;
  if (
    !element ||
    element.totalSize > MAX_CUED_BLOCK_ELEMENT_BYTES ||
    element.totalSize > elementAvailableBytes
  ) {
    throw invalidCuePosition("CueRelativePosition referenced an invalid block element", {
      clusterPosition: cue.clusterPosition,
      relativePosition: cue.relativePosition
    });
  }
  var blockData = response.buffer.slice(element.start);
  if (blockData.length < element.totalSize) {
    blockData = (
      await requestRange(
        mediaUrl,
        absoluteStart,
        absoluteStart + element.totalSize - 1,
        MAX_CUED_BLOCK_ELEMENT_BYTES,
        0,
        requestContext
      )
    ).buffer;
    element = readElement(blockData, 0, blockData.length, false);
  } else {
    blockData = blockData.slice(0, element.totalSize);
    element = readElement(blockData, 0, blockData.length, false);
  }
  if (!element) {
    throw invalidCuePosition("Cued subtitle block is truncated", {
      clusterPosition: cue.clusterPosition,
      relativePosition: cue.relativePosition
    });
  }
  return parseCuedBlock(blockData, element, track, cue, metadata.timecodeScaleNs);
}

async function loadCueFrames(mediaUrl, metadata, track, cues, requestContext) {
  var directCues = [];
  var fallbackPositions = [];
  cues.forEach(function (cue) {
    if (cue.relativePosition == null) fallbackPositions.push(cue.clusterPosition);
    else directCues.push(cue);
  });
  var directResults = await mapWithConcurrency(
    directCues,
    MAX_CONCURRENT_CUED_BLOCK_REQUESTS,
    async function (cue) {
      try {
        return {
          frame: await loadCuedBlockFrame(mediaUrl, metadata, track, cue, requestContext)
        };
      } catch (error) {
        if (error && error.code === "INVALID_CUE_POSITION") {
          return { fallbackClusterPosition: cue.clusterPosition };
        }
        throw error;
      }
    }
  );
  var frames = [];
  directResults.forEach(function (result) {
    if (result.frame) frames.push(result.frame);
    if (result.fallbackClusterPosition != null) {
      fallbackPositions.push(result.fallbackClusterPosition);
    }
  });
  if (fallbackPositions.length) {
    var fallbackClusters = new Set(fallbackPositions);
    frames = frames.filter(function (frame) {
      return !fallbackClusters.has(frame.clusterPosition);
    });
    frames.push.apply(
      frames,
      await loadClusterFrames(mediaUrl, metadata, track, Array.from(fallbackClusters))
    );
  }
  frames.sort(compareFrames);
  return frames;
}

function compareFrames(left, right) {
  return (
    left.timestampNs - right.timestampNs ||
    left.clusterPosition - right.clusterPosition ||
    left.blockOrder - right.blockOrder
  );
}

function uniqueFramesInRange(frames, startMs, endMs) {
  var uniqueFrames = [];
  var seen = new Set();
  frames.forEach(function (frame) {
    if (frame.timestampMs < startMs || frame.timestampMs > endMs) return;
    var key = frame.clusterPosition + ":" + frame.blockOrder;
    if (seen.has(key)) return;
    seen.add(key);
    uniqueFrames.push(frame);
  });
  return uniqueFrames;
}

async function mapWithConcurrency(items, concurrency, iteratee) {
  var results = new Array(items.length);
  var nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      var index = nextIndex;
      nextIndex += 1;
      results[index] = await iteratee(items[index], index);
    }
  }
  var workers = [];
  var workerCount = Math.min(Math.max(1, concurrency), items.length);
  for (var index = 0; index < workerCount; index += 1) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return results;
}

function requestClusterRange(mediaUrl, absoluteStart, clusterSize) {
  var absoluteEnd = absoluteStart + clusterSize - 1;
  var key = mediaUrl + "::" + absoluteStart + "::" + absoluteEnd;
  if (clusterRangeRequests.has(key)) return clusterRangeRequests.get(key);
  var request = requestRange(mediaUrl, absoluteStart, absoluteEnd, MAX_CLUSTER_BYTES);
  var trackedRequest = request.then(
    function (result) {
      if (clusterRangeRequests.get(key) === trackedRequest) clusterRangeRequests.delete(key);
      return result;
    },
    function (error) {
      if (clusterRangeRequests.get(key) === trackedRequest) clusterRangeRequests.delete(key);
      throw error;
    }
  );
  clusterRangeRequests.set(key, trackedRequest);
  return trackedRequest;
}

function parsePgsSegments(payload) {
  var segments = [];
  var offset = 0;
  while (offset < payload.length) {
    if (offset + 3 > payload.length) {
      throw bitmapSubtitleError("INVALID_PGS", "PGS block ended inside a segment header");
    }
    var segmentType = payload[offset];
    var segmentSize = payload.readUInt16BE(offset + 1);
    var segmentEnd = offset + 3 + segmentSize;
    if (segmentEnd > payload.length) {
      throw bitmapSubtitleError("INVALID_PGS", "PGS segment exceeds its Matroska block");
    }
    var compositionState = null;
    if (segmentType === PGS_SEGMENT_PRESENTATION_COMPOSITION && segmentSize >= 8) {
      compositionState = payload[offset + 3 + 7];
    }
    segments.push({
      type: segmentType,
      size: segmentSize,
      compositionState: compositionState,
      data: payload.slice(offset, segmentEnd)
    });
    offset = segmentEnd;
  }
  if (!segments.length) {
    throw bitmapSubtitleError("INVALID_PGS", "Matroska block contained no PGS segments");
  }
  return segments;
}

function getPgsFrameSyncState(frame) {
  var segments = parsePgsSegments(frame.payload);
  for (var index = 0; index < segments.length; index += 1) {
    var state = segments[index].compositionState;
    if (
      state === PGS_COMPOSITION_STATE_EPOCH_START ||
      state === PGS_COMPOSITION_STATE_ACQUISITION_POINT
    ) {
      return state;
    }
  }
  return null;
}

function findLatestPgsSyncFrame(frames, startMs) {
  for (var index = frames.length - 1; index >= 0; index -= 1) {
    var frame = frames[index];
    if (frame.timestampMs <= startMs && getPgsFrameSyncState(frame) != null) {
      return frame;
    }
  }
  return null;
}

function findFirstPgsSyncFrame(frames, startMs, endMs) {
  for (var index = 0; index < frames.length; index += 1) {
    var frame = frames[index];
    if (
      frame.timestampMs >= startMs &&
      frame.timestampMs <= endMs &&
      getPgsFrameSyncState(frame) != null
    ) {
      return frame;
    }
  }
  return null;
}

function getPgsSyncType(frame) {
  var state = frame ? getPgsFrameSyncState(frame) : null;
  if (state === PGS_COMPOSITION_STATE_EPOCH_START) return "epoch";
  if (state === PGS_COMPOSITION_STATE_ACQUISITION_POINT) return "acquisition";
  return null;
}

function appendPgsSupSegment(chunks, timestampNs, segmentData) {
  var pts = Math.floor((timestampNs * 9) / 100000) % PGS_TIMESTAMP_WRAP;
  if (!Number.isFinite(pts) || pts < 0) {
    throw bitmapSubtitleError("INVALID_TIMESTAMP", "PGS timestamp is outside its valid range");
  }
  var header = Buffer.alloc(10);
  header.writeUInt16BE(0x5047, 0);
  header.writeUInt32BE(pts >>> 0, 2);
  header.writeUInt32BE(0, 6);
  chunks.push(header, segmentData);
  return header.length + segmentData.length;
}

function serializePgsFrames(frames) {
  var chunks = [];
  var segmentCount = 0;
  var outputLength = 0;
  frames.forEach(function (frame) {
    parsePgsSegments(frame.payload).forEach(function (segment) {
      outputLength += appendPgsSupSegment(chunks, frame.timestampNs, segment.data);
      segmentCount += 1;
      if (outputLength > MAX_WINDOW_BYTES) {
        throw bitmapSubtitleError("WINDOW_TOO_LARGE", "PGS window exceeded its safety limit");
      }
    });
  });
  return {
    data: Buffer.concat(chunks),
    segmentCount: segmentCount
  };
}

async function findPgsContext(mediaUrl, metadata, track, startMs, endMs, requestContext) {
  var trackCues = getTrackCues(metadata, track.number);
  if (!trackCues.length) {
    throw bitmapSubtitleError("TRACK_CUES_NOT_FOUND", "PGS track has no seekable cue entries");
  }
  var cueIndex = -1;
  for (var index = 0; index < trackCues.length; index += 1) {
    if (trackCues[index].timeMs <= startMs) cueIndex = index;
    else break;
  }

  var scannedCues = 0;
  var earliestAllowedMs = Math.max(0, startMs - PGS_MAX_SYNC_LOOKBACK_MS);
  while (
    cueIndex >= 0 &&
    trackCues[cueIndex].timeMs >= earliestAllowedMs &&
    scannedCues < PGS_MAX_SYNC_SCAN_CUES
  ) {
    var batchStart = Math.max(0, cueIndex - PGS_SYNC_SCAN_BATCH_CUES + 1);
    var batch = trackCues.slice(batchStart, cueIndex + 1).filter(function (cue) {
      return cue.timeMs >= earliestAllowedMs || cue.timeMs === 0;
    });
    if (!batch.length) break;
    var frames = await loadCueFrames(mediaUrl, metadata, track, batch, requestContext);
    var syncFrame = findLatestPgsSyncFrame(frames, startMs);
    if (syncFrame) {
      return {
        timestampMs: syncFrame.timestampMs,
        clusterPosition: syncFrame.clusterPosition,
        trackCues: trackCues,
        syncType: getPgsSyncType(syncFrame),
        prefetchedFrames: frames
      };
    }
    scannedCues += batch.length;
    if (batchStart === 0) break;
    cueIndex = batchStart - 1;
  }

  var requestedCues = trackCues.filter(function (cue) {
    return cue.timeMs >= startMs && cue.timeMs <= endMs;
  });
  if (!requestedCues.length) {
    return { empty: true, trackCues: trackCues, syncType: "empty" };
  }
  var requestedFrames = await loadCueFrames(
    mediaUrl,
    metadata,
    track,
    requestedCues,
    requestContext
  );
  var futureSyncFrame = findFirstPgsSyncFrame(requestedFrames, startMs, endMs);
  if (futureSyncFrame) {
    return {
      timestampMs: futureSyncFrame.timestampMs,
      clusterPosition: futureSyncFrame.clusterPosition,
      trackCues: trackCues,
      syncType: getPgsSyncType(futureSyncFrame),
      prefetchedFrames: requestedFrames
    };
  }
  throw bitmapSubtitleError(
    "PGS_SYNC_NOT_FOUND",
    "PGS epoch or acquisition point was not found within the bounded seek context",
    { startMs: startMs, lookbackMs: PGS_MAX_SYNC_LOOKBACK_MS, scannedCues: scannedCues }
  );
}

function encodePts(timestampMs) {
  var pts = (timestampMs * 90) % 8589934592;
  return Buffer.from([
    ((Math.floor(pts / 1073741824) & 0x07) << 1) | 0x21,
    Math.floor(pts / 4194304) & 0xff,
    ((Math.floor(pts / 32768) & 0x7f) << 1) | 0x01,
    Math.floor(pts / 128) & 0xff,
    ((pts & 0x7f) << 1) | 0x01
  ]);
}

function appendPesPacket(chunks, timestampMs, payload) {
  var maxPayloadBytes = 0xffff - 9;
  var payloadOffset = 0;
  var bytesWritten = 0;
  do {
    var payloadChunk = payload.slice(payloadOffset, payloadOffset + maxPayloadBytes);
    var pesLength = payloadChunk.length + 9;
    var header = Buffer.alloc(6);
    header.writeUInt32BE(0x000001bd, 0);
    header.writeUInt16BE(pesLength, 4);
    var packetChunks = [
      MPEG_PACK_HEADER,
      header,
      Buffer.from([0x80, 0x80, 0x05]),
      encodePts(timestampMs),
      Buffer.from([0x20]),
      payloadChunk
    ];
    chunks.push.apply(chunks, packetChunks);
    bytesWritten += packetChunks.reduce(function (sum, chunk) {
      return sum + chunk.length;
    }, 0);
    payloadOffset += payloadChunk.length;
  } while (payloadOffset < payload.length);
  return bytesWritten;
}

function padLeft(value, width) {
  var text = String(value);
  while (text.length < width) text = "0" + text;
  return text;
}

function formatTimestamp(timestampMs) {
  var total = Math.max(0, Math.round(timestampMs));
  var hours = Math.floor(total / 3600000);
  var minutes = Math.floor((total % 3600000) / 60000);
  var seconds = Math.floor((total % 60000) / 1000);
  var millis = total % 1000;
  return (
    padLeft(hours, 2) +
    ":" +
    padLeft(minutes, 2) +
    ":" +
    padLeft(seconds, 2) +
    ":" +
    padLeft(millis, 3)
  );
}

function normalizeIdxHeader(codecPrivate) {
  return (
    codecPrivate
      .toString("utf8")
      .replace(/\r\n?/g, "\n")
      .split("\n")
      .map(function (line) {
        return line.replace(/\0/g, "").trim();
      })
      .filter(function (line) {
        return line && !/^timestamp:/i.test(line);
      })
      .join("\n") + "\n"
  );
}

function buildVobSubWindowPayload(track, frames) {
  if (!track.codecPrivate.length) {
    throw bitmapSubtitleError("MISSING_CODEC_PRIVATE", "VOBSUB track has no IDX metadata");
  }
  var chunks = [];
  var idxContent = normalizeIdxHeader(track.codecPrivate);
  var outputLength = 0;
  frames.forEach(function (frame) {
    if (!validateVobSubPayload(frame.payload)) {
      throw bitmapSubtitleError(
        "INVALID_VOBSUB",
        "Matroska block contained an invalid VOBSUB packet"
      );
    }
    idxContent +=
      "timestamp: " +
      formatTimestamp(frame.timestampMs) +
      ", filepos: " +
      padLeft(outputLength.toString(16).toUpperCase(), 8) +
      "\n";
    outputLength += appendPesPacket(chunks, frame.timestampMs, frame.payload);
    if (outputLength > MAX_WINDOW_BYTES) {
      throw bitmapSubtitleError("WINDOW_TOO_LARGE", "VOBSUB window exceeded its safety limit");
    }
  });
  var subData = Buffer.concat(chunks);
  return {
    format: "vobsub",
    cueCount: frames.length,
    idxContent: idxContent,
    subBase64: subData.toString("base64"),
    subBytes: subData.length
  };
}

function buildPgsWindowPayload(frames) {
  var serialized = serializePgsFrames(frames);
  return {
    format: "pgs",
    cueCount: frames.length,
    segmentCount: serialized.segmentCount,
    supBase64: serialized.data.toString("base64"),
    supBytes: serialized.data.length
  };
}

async function buildWindow(mediaUrl, trackNumber, startSeconds, endSeconds, requestContext) {
  var metadata = await loadMetadata(mediaUrl);
  var track = metadata.tracks.find(function (entry) {
    return entry.number === trackNumber && isBitmapSubtitleTrack(entry);
  });
  if (!track) {
    throw bitmapSubtitleError("TRACK_NOT_FOUND", "Requested bitmap subtitle track was not found");
  }
  var format = getBitmapSubtitleFormat(track);
  var startMs = Math.max(0, Math.floor(startSeconds * 1000));
  var endMs = Math.max(startMs + 1000, Math.floor(endSeconds * 1000));
  var contextStartMs = Math.max(0, startMs - 30000);
  var contextType = format === "pgs" ? null : "vobsub";
  var positions;
  var pgsCues = null;
  var prefetchedFrames = null;
  if (format === "pgs") {
    var context = await findPgsContext(mediaUrl, metadata, track, startMs, endMs, requestContext);
    contextType = context.syncType;
    if (context.empty) {
      contextStartMs = startMs;
      positions = [];
    } else {
      contextStartMs = context.timestampMs;
      prefetchedFrames = context.prefetchedFrames || null;
      pgsCues = context.trackCues.filter(function (cue) {
        return cue.timeMs >= contextStartMs && cue.timeMs <= endMs;
      });
      if (
        !pgsCues.some(function (cue) {
          return cue.clusterPosition === context.clusterPosition;
        })
      ) {
        var contextCue = context.trackCues.find(function (cue) {
          return cue.clusterPosition === context.clusterPosition;
        });
        if (contextCue) pgsCues.unshift(contextCue);
      }
    }
  } else {
    positions = selectClusterPositions(metadata, trackNumber, startMs, endMs);
  }
  var loadedFrames;
  if (format === "pgs") {
    var prefetchedKeys = new Set(
      (prefetchedFrames || []).map(function (frame) {
        return cuePositionKey(frame);
      })
    );
    var remainingCues = (pgsCues || []).filter(function (cue) {
      return !prefetchedKeys.has(cuePositionKey(cue));
    });
    loadedFrames = (prefetchedFrames || []).concat(
      await loadCueFrames(mediaUrl, metadata, track, remainingCues, requestContext)
    );
    loadedFrames.sort(compareFrames);
  } else {
    loadedFrames = await loadClusterFrames(mediaUrl, metadata, track, positions);
  }
  var frames = uniqueFramesInRange(loadedFrames, contextStartMs, endMs);
  var payload =
    format === "pgs" ? buildPgsWindowPayload(frames) : buildVobSubWindowPayload(track, frames);
  return Object.assign(payload, {
    trackNumber: trackNumber,
    language: track.language || "",
    name: track.name || "",
    windowStartSeconds: startMs / 1000,
    windowEndSeconds: endMs / 1000,
    contextStartSeconds: contextStartMs / 1000,
    contextType: contextType
  });
}

async function getBitmapSubtitleWindow(options) {
  var mediaUrl = normalizeMediaUrl(options && options.url);
  var trackNumber = Math.trunc(Number(options && options.trackNumber));
  var startSeconds = Math.max(0, Number(options && options.startSeconds) || 0);
  var requestedEnd = Number(options && options.endSeconds);
  var endSeconds = Number.isFinite(requestedEnd)
    ? Math.min(startSeconds + 180, Math.max(startSeconds + 1, requestedEnd))
    : startSeconds + 120;
  if (!Number.isFinite(trackNumber) || trackNumber <= 0) {
    throw bitmapSubtitleError("INVALID_TRACK", "Bitmap subtitle track number is invalid");
  }
  var normalizedWindow = normalizeWindowRange(startSeconds, endSeconds);
  var bucketStart = normalizedWindow.startSeconds;
  var bucketEnd = normalizedWindow.endSeconds;
  var cacheKey = mediaUrl + "::" + trackNumber + "::" + bucketStart + "::" + bucketEnd;
  var activeKey = mediaUrl + "::" + trackNumber;
  var cached = getCached(windowCache, cacheKey);
  if (cached) {
    cancelActivePgsWindowRequest(activeKey);
    return cached;
  }
  if (windowRequests.has(cacheKey)) return windowRequests.get(cacheKey);
  cancelActivePgsWindowRequest(activeKey);
  var requestContext = { cancelled: false, requests: new Set() };
  activePgsWindowRequests.set(activeKey, requestContext);
  var request = buildWindow(mediaUrl, trackNumber, bucketStart, bucketEnd, requestContext);
  windowRequests.set(cacheKey, request);
  try {
    var result = await request;
    setCached(windowCache, cacheKey, result, WINDOW_CACHE_TTL_MS, MAX_WINDOW_CACHE_ENTRIES);
    return result;
  } finally {
    windowRequests.delete(cacheKey);
    if (activePgsWindowRequests.get(activeKey) === requestContext) {
      activePgsWindowRequests.delete(activeKey);
    }
  }
}

function normalizeWindowRange(startSeconds, endSeconds) {
  var bucketStart =
    Math.floor(Math.max(0, startSeconds) / WINDOW_BUCKET_SECONDS) * WINDOW_BUCKET_SECONDS;
  var quantizedEnd =
    Math.ceil(Math.max(bucketStart + 1, endSeconds) / WINDOW_END_QUANTUM_SECONDS) *
    WINDOW_END_QUANTUM_SECONDS;
  var bucketEnd = Math.max(bucketStart + MIN_WINDOW_SECONDS, quantizedEnd);
  bucketEnd = Math.min(bucketStart + MAX_WINDOW_SECONDS, bucketEnd);
  return { startSeconds: bucketStart, endSeconds: bucketEnd };
}

function cancelActivePgsWindowRequest(activeKey) {
  var requestContext = activePgsWindowRequests.get(activeKey);
  if (!requestContext) return;
  cancelRequestContext(requestContext);
  activePgsWindowRequests.delete(activeKey);
}

function cancelRequestContext(requestContext) {
  requestContext.cancelled = true;
  requestContext.requests.forEach(function (activeRequest) {
    activeRequest.destroy(
      bitmapSubtitleError("REQUEST_SUPERSEDED", "Bitmap subtitle request was superseded")
    );
  });
  requestContext.requests.clear();
}

async function prepareBitmapSubtitleSource(options) {
  var mediaUrl = normalizeMediaUrl(options && options.url);
  var metadata = await loadMetadata(mediaUrl);
  var bitmapTracks = metadata.tracks.filter(function (track) {
    return isBitmapSubtitleTrack(track);
  });
  return {
    prepared: true,
    bitmapTrackCount: bitmapTracks.length,
    bitmapFormats: Array.from(
      new Set(
        bitmapTracks.map(function (track) {
          return getBitmapSubtitleFormat(track);
        })
      )
    ),
    cueCount: metadata.cues.length
  };
}

function clearBitmapSubtitleCaches() {
  metadataCache.clear();
  metadataRequests.clear();
  windowCache.clear();
  windowRequests.clear();
  clusterRangeRequests.clear();
  Array.from(activePgsWindowRequests.keys()).forEach(function (activeKey) {
    cancelActivePgsWindowRequest(activeKey);
  });
}

module.exports = {
  getBitmapSubtitleWindow: getBitmapSubtitleWindow,
  prepareBitmapSubtitleSource: prepareBitmapSubtitleSource,
  clearBitmapSubtitleCaches: clearBitmapSubtitleCaches,
  _test: {
    parseHeader: parseHeader,
    parseCues: parseCues,
    parseCluster: parseCluster,
    getTrackCues: getTrackCues,
    loadCueFrames: loadCueFrames,
    requestRange: requestRange,
    cancelRequestContext: cancelRequestContext,
    getBitmapSubtitleFormat: getBitmapSubtitleFormat,
    parsePgsSegments: parsePgsSegments,
    getPgsFrameSyncState: getPgsFrameSyncState,
    findLatestPgsSyncFrame: findLatestPgsSyncFrame,
    findFirstPgsSyncFrame: findFirstPgsSyncFrame,
    appendPgsSupSegment: appendPgsSupSegment,
    serializePgsFrames: serializePgsFrames,
    buildVobSubWindowPayload: buildVobSubWindowPayload,
    buildPgsWindowPayload: buildPgsWindowPayload,
    normalizeIdxHeader: normalizeIdxHeader,
    appendPesPacket: appendPesPacket,
    normalizeWindowRange: normalizeWindowRange,
    mapWithConcurrency: mapWithConcurrency,
    formatTimestamp: formatTimestamp,
    readElement: readElement
  }
};
