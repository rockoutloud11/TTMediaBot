import http from 'node:http';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import { statSync } from 'node:fs';
import path from 'node:path';
import { URL } from 'node:url';
import { ClientType, Constants, Innertube, UniversalCache, Platform, YTNodes } from 'youtubei.js';
import { ExpiringLruCache } from './cache.mjs';
import { musicItemPayload, normalizeSearchKey, streamCacheTtlMs } from './media.mjs';

const HOST = process.env.YOUTUBE_BRIDGE_HOST || '127.0.0.1';
const PORT = Number(process.env.YOUTUBE_BRIDGE_PORT || 4417);
const POT_URL = process.env.POT_PROVIDER_URL || 'http://127.0.0.1:4416/get_pot';
const BOTS_ROOT = path.resolve(process.env.TTMEDIABOT_BOTS_ROOT || '/bots');
const USER_AGENT = process.env.YOUTUBE_BRIDGE_USER_AGENT ||
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 Version/18.5 Mobile/15E148 Safari/604.1';

// YouTube.js 18 requires an evaluator to decipher player signatures/nsig.
Platform.shim.eval = async (data) => new Function(data.output)();

const SESSION_CACHE_MAX_ENTRIES = 64;
const sessionCache = new Map();
let searchSessionPromise = null;
const RESOLVE_CACHE_MAX_ENTRIES = 1024;
const resolveCache = new ExpiringLruCache({ maxEntries: RESOLVE_CACHE_MAX_ENTRIES });
const pendingResolutions = new Map();
const SEARCH_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const searchCache = new ExpiringLruCache({ maxEntries: 2048 });
const RECOMMENDATION_CACHE_TTL_MS = 30 * 60 * 1000;
const recommendationCache = new ExpiringLruCache({ maxEntries: 512 });

const DISK_CACHE_FILE = path.resolve(process.env.BRIDGE_CACHE_FILE || path.join(path.dirname(new URL(import.meta.url).pathname), 'bridge_cache.json'));

async function loadDiskCache() {
  try {
    const raw = await fs.readFile(DISK_CACHE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed.search) searchCache.load(parsed.search);
    if (parsed.resolve) resolveCache.load(parsed.resolve);
    console.log(`[youtube-bridge] Loaded persistent disk cache (search: ${searchCache.size}, resolve: ${resolveCache.size})`);
  } catch (err) {
    if (err?.code !== 'ENOENT') {
      console.warn('[youtube-bridge] Could not load disk cache:', err.message);
    }
  }
}

let saveTimer = null;
function scheduleSaveDiskCache() {
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    try {
      const data = {
        search: searchCache.dump(),
        resolve: resolveCache.dump()
      };
      await fs.writeFile(DISK_CACHE_FILE, JSON.stringify(data), 'utf8');
    } catch (err) {
      console.warn('[youtube-bridge] Could not save disk cache:', err.message);
    }
  }, 2000);
}

function json(res, status, body) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': data.length
  });
  res.end(data);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function getBotCookieFile(botId) {
  if (typeof botId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(botId)) {
    throw new Error('Invalid or missing bot_id');
  }
  return path.join(BOTS_ROOT, botId, 'cookies.txt');
}

function cookieFileKey(cookieFile) {
  if (!cookieFile) return 'anonymous';
  try {
    const stat = statSync(cookieFile);
    return `${cookieFile}:${stat.mtimeMs}:${stat.size}`;
  } catch {
    return `${cookieFile}:missing`;
  }
}

async function netscapeCookiesToHeader(cookieFile) {
  if (!cookieFile) return '';
  let text;
  try {
    text = await fs.readFile(cookieFile, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return '';
    throw error;
  }

  const cookies = new Map();
  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('#HttpOnly_')) line = line.slice('#HttpOnly_'.length);
    else if (line.startsWith('#')) continue;

    const parts = line.split('\t');
    if (parts.length < 7) continue;
    const domain = parts[0].toLowerCase().replace(/^\./, '');
    if (domain !== 'youtube.com' && !domain.endsWith('.youtube.com')) continue;
    const name = parts[5];
    const value = parts.slice(6).join('\t');
    if (name) cookies.set(name, value);
  }
  return Array.from(cookies, ([name, value]) => `${name}=${value}`).join('; ');
}

function pageConfigValue(page, key) {
  const match = page.match(new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`));
  if (!match) return undefined;
  try {
    return JSON.parse(`"${match[1]}"`);
  } catch {
    return match[1];
  }
}

async function getWebSessionData(cookie) {
  if (!cookie) return {};
  const response = await fetch('https://m.youtube.com/', {
    headers: {
      'Cookie': cookie,
      'User-Agent': USER_AGENT,
      'Accept-Language': 'en-US,en;q=0.9'
    }
  });
  if (!response.ok) {
    throw new Error(`YouTube session page returned HTTP ${response.status}`);
  }
  const page = await response.text();
  return {
    dataSyncId: pageConfigValue(page, 'DATASYNC_ID'),
    visitorData: pageConfigValue(page, 'VISITOR_DATA')
  };
}

// ---------------------------------------------------------------------------
// Login check. When a bot's cookies stop working, YouTube quietly treats the
// bot as signed out and only serves about the first minute of each song.
// /login-status loads youtube.com once with the bot's cookies and reports
// YouTube's own LOGGED_IN flag. Results are cached per cookie file for 10
// minutes (force: true skips the cache). Cookie values are never logged.
// ---------------------------------------------------------------------------
const LOGIN_CHECK_TTL_MS = 10 * 60 * 1000;
const LOGIN_CHECK_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const loginStatusCache = new Map();

async function checkLoginUncached(cookieFile) {
  const checkedAt = new Date().toISOString();
  const cookie = await netscapeCookiesToHeader(cookieFile);
  if (!cookie) return { cookies: false, logged_in: null, checked_at: checkedAt };
  const response = await fetch('https://www.youtube.com/', {
    headers: {
      'Cookie': cookie,
      'User-Agent': LOGIN_CHECK_USER_AGENT,
      'Accept-Language': 'en-US,en;q=0.9'
    }
  });
  if (!response.ok) {
    return { cookies: true, logged_in: null, checked_at: checkedAt, error: `youtube.com returned HTTP ${response.status}` };
  }
  const page = await response.text();
  const match = page.match(/"LOGGED_IN"\s*:\s*(true|false)/);
  if (!match) {
    return { cookies: true, logged_in: null, checked_at: checkedAt, error: 'youtube.com did not report a login state' };
  }
  return { cookies: true, logged_in: match[1] === 'true', checked_at: checkedAt };
}

async function getLoginStatus(body) {
  const cookieFile = body.cookie_file;
  const key = cookieFileKey(cookieFile);
  const cached = loginStatusCache.get(key);
  if (cached && !body.force && Date.now() - cached.at < LOGIN_CHECK_TTL_MS) return cached.result;
  for (const cachedKey of loginStatusCache.keys()) {
    if (cachedKey !== key && cachedKey.startsWith(`${cookieFile}:`)) loginStatusCache.delete(cachedKey);
  }
  const result = await checkLoginUncached(cookieFile);
  if (result.logged_in !== null || !result.cookies) loginStatusCache.set(key, { at: Date.now(), result });
  console.log(`[youtube-bridge] login check bot=${body.bot_id}: cookies=${result.cookies} logged_in=${result.logged_in}${result.error ? ` (${result.error})` : ''}`);
  return result;
}

async function getSession(cookieFile) {
  const key = cookieFileKey(cookieFile);
  const cached = sessionCache.get(key);
  if (cached) {
    sessionCache.delete(key);
    sessionCache.set(key, cached);
    return cached;
  }

  for (const cachedKey of sessionCache.keys()) {
    if (cachedKey.startsWith(`${cookieFile}:`)) sessionCache.delete(cachedKey);
  }

  const contextPromise = (async () => {
    const cookie = await netscapeCookiesToHeader(cookieFile);
    const webSession = await getWebSessionData(cookie);
    const session = await Innertube.create({
      cookie: cookie || undefined,
      user_agent: USER_AGENT,
      client_type: ClientType.MWEB,
      visitor_data: webSession.visitorData,
      cache: new UniversalCache(true),
      enable_session_cache: true,
      generate_session_locally: true,
      retrieve_player: true
    });
    return { session };
  })().catch((error) => {
    sessionCache.delete(key);
    throw error;
  });

  sessionCache.set(key, contextPromise);
  while (sessionCache.size > SESSION_CACHE_MAX_ENTRIES) {
    sessionCache.delete(sessionCache.keys().next().value);
  }
  return contextPromise;
}

async function getSearchSession() {
  if (!searchSessionPromise) {
    searchSessionPromise = Innertube.create({
      client_type: ClientType.WEB,
      cache: new UniversalCache(true),
      enable_session_cache: true,
      generate_session_locally: true,
      retrieve_player: false,
      fail_fast: true
    }).catch((error) => {
      searchSessionPromise = null;
      throw error;
    });
  }
  return searchSessionPromise;
}

async function getPoToken(contentBinding) {
  try {
    const response = await fetch(POT_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content_binding: contentBinding })
    });
    if (!response.ok) {
      const body = await response.text();
      console.warn(`[youtube-bridge] POT provider HTTP ${response.status}: ${body.slice(0, 300)}`);
      return undefined;
    }
    const data = await response.json();
    return data.poToken || data.po_token || undefined;
  } catch (error) {
    console.warn(`[youtube-bridge] POT provider unavailable: ${error.message}`);
    return undefined;
  }
}

function extractVideoId(input) {
  if (!input) return null;
  if (/^[A-Za-z0-9_-]{11}$/.test(input)) return input;
  try {
    const url = new URL(input);
    if (url.hostname === 'youtu.be') return url.pathname.split('/').filter(Boolean)[0] || null;
    if (url.searchParams.get('v')) return url.searchParams.get('v');
    const shorts = url.pathname.match(/^\/shorts\/([^/?]+)/);
    if (shorts) return shorts[1];
  } catch {}
  return null;
}

async function extractPlaylistId(input, session) {
  if (!input) return null;
  if (/^[A-Za-z0-9_-]{18,50}$/.test(input)) {
    if (input.startsWith('UC') && input.length === 24) {
      return 'UU' + input.slice(2);
    }
    return input;
  }
  try {
    const url = new URL(input);
    const listParam = url.searchParams.get('list');
    if (listParam) return listParam;

    const channelMatch = url.pathname.match(/\/channel\/(UC[A-Za-z0-9_-]{22})/);
    if (channelMatch) {
      return 'UU' + channelMatch[1].slice(2);
    }

    if (session && (url.pathname.includes('@') || url.pathname.includes('/c/') || url.pathname.includes('/user/') || url.pathname.includes('/channel/'))) {
      try {
        const res = await session.resolveURL(input);
        const browseId = res?.payload?.browseId || res?.endpoint?.payload?.browseId;
        if (browseId && browseId.startsWith('UC')) {
          return 'UU' + browseId.slice(2);
        } else if (browseId) {
          return browseId;
        }
      } catch (e) {
        console.warn(`[youtube-bridge] resolveURL failed for ${input}: ${e.message}`);
      }
    }
  } catch {}
  return null;
}

function textValue(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (typeof value.toString === 'function') return value.toString();
  return '';
}

function ownerName(info) {
  const basic = info?.basic_info || {};
  return textValue(basic.author) || textValue(basic.channel?.name) || '';
}

function infoPayload(info, videoId) {
  const basic = info?.basic_info || {};
  return {
    id: basic.id || videoId,
    videoId: basic.id || videoId,
    title: basic.title || '',
    uploader: ownerName(info),
    duration: basic.duration || 0,
    is_live: Boolean(basic.is_live || basic.is_live_content),
    webpage_url: `https://www.youtube.com/watch?v=${basic.id || videoId}`,
    http_headers: { 'User-Agent': USER_AGENT }
  };
}

function formatPayload(format) {
  return {
    url: format.url,
    itag: format.itag,
    mime_type: format.mime_type,
    bitrate: format.bitrate,
    average_bitrate: format.average_bitrate,
    content_length: format.content_length,
    quality: format.quality,
    quality_label: format.quality_label,
    audio_quality: format.audio_quality,
    audio_sample_rate: format.audio_sample_rate,
    audio_channels: format.audio_channels,
    has_audio: format.has_audio,
    has_video: format.has_video
  };
}

async function getPlayableInfo(session, videoId, client, poToken) {
  const targetClient = client === 'YTMUSIC' ? ClientType.MWEB : client;
  return session.getBasicInfo(videoId, { client: targetClient, po_token: poToken });
}

function playabilityDescription(info) {
  const status = info?.playability_status?.status || 'UNKNOWN';
  const reason = info?.playability_status?.reason || '';
  return reason ? `${status}: ${reason}` : status;
}

async function resolveFormat(context, videoId, requestedClient, formatOptions) {
  // WEB is SABR-only for many videos in 2026. MWEB still exposes classic
  // adaptive formats and is the preferred web playback client here.
  const clients = requestedClient === 'YTMUSIC'
    ? ['YTMUSIC', 'MWEB', ClientType.TV_EMBEDDED]
    : ['MWEB', ClientType.TV_EMBEDDED];
  const failures = [];
  const { session } = context;

  for (const client of clients) {
    const clientStartedAt = performance.now();
    try {
      const poStartedAt = performance.now();
      const poToken = client === ClientType.TV_EMBEDDED
        ? undefined
        : await getPoToken(videoId);
      console.log(`[youtube-bridge-timing] video=${videoId} client=${client} stage=po-token elapsed_ms=${Math.round(performance.now() - poStartedAt)} available=${Boolean(poToken)}`);

      const playerStartedAt = performance.now();
      const info = await getPlayableInfo(session, videoId, client, poToken);
      console.log(`[youtube-bridge-timing] video=${videoId} client=${client} stage=player elapsed_ms=${Math.round(performance.now() - playerStartedAt)} status=${info?.playability_status?.status || 'UNKNOWN'}`);
      if (!info?.streaming_data) {
        throw new Error(`no streaming data (${playabilityDescription(info)})`);
      }

      const formatStartedAt = performance.now();
      const format = info.chooseFormat(formatOptions);
      console.log(`[youtube-bridge-timing] video=${videoId} client=${client} stage=choose-format elapsed_ms=${Math.round(performance.now() - formatStartedAt)} itag=${format.itag}`);
      if (!session.session.player) {
        throw new Error('YouTube player is unavailable');
      }

      session.session.player.po_token = poToken;
      if (sabrLib && !format.url && !format.signature_cipher && !format.cipher
        && info.streaming_data?.server_abr_streaming_url) {
        // ttmediabot-sabr-v3: YouTube sent no plain link for this song, only
        // SABR. The bot gets a /sabr/ link on this bridge instead (withSabrUrl).
        format.url = '';
        console.log(`[youtube-bridge] ${videoId} client=${client} has no plain link, sabr only`);
        return { info, format, client };
      }
      const decipherStartedAt = performance.now();
      format.url = await format.decipher(session.session.player);
      console.log(`[youtube-bridge-timing] video=${videoId} client=${client} stage=decipher elapsed_ms=${Math.round(performance.now() - decipherStartedAt)}`);

      if (!format.url) {
        throw new Error('decipher returned an empty stream URL');
      }

      console.log(`[youtube-bridge] resolved ${videoId} with client=${client} itag=${format.itag} elapsed_ms=${Math.round(performance.now() - clientStartedAt)}`);
      return { info, format, client };
    } catch (error) {
      const message = error?.message || String(error);
      failures.push(`${client}: ${message}`);
      console.warn(`[youtube-bridge] ${videoId} client=${client} failed: ${message}`);
    }
  }

  throw new Error(`Unable to resolve stream for ${videoId}; ${failures.join(' | ')}`);
}

async function resolveTrack(body) {
  const startedAt = performance.now();
  const videoId = body.video_id || extractVideoId(body.url);
  if (!videoId) throw new Error('Invalid YouTube URL or video ID');
  const requestedClient = body.client === 'YTMUSIC' ? 'YTMUSIC' : 'MWEB';
  const cacheKey = `${cookieFileKey(body.cookie_file)}:${requestedClient}:${videoId}`;
  const cached = resolveCache.get(cacheKey);
  if (cached) {
    console.log(`[youtube-bridge] resolve cache hit ${videoId} client=${requestedClient} elapsed_ms=${Math.round(performance.now() - startedAt)} cache_entries=${resolveCache.size}`);
    return cached;
  }
  console.log(`[youtube-bridge] resolve cache miss ${videoId} client=${requestedClient} cache_entries=${resolveCache.size}`);

  const pending = pendingResolutions.get(cacheKey);
  if (pending) {
    console.log(`[youtube-bridge] joining pending resolve ${videoId} client=${requestedClient} pending=${pendingResolutions.size}`);
    return pending;
  }

  const resolution = resolveTrackUncached(body, videoId, requestedClient)
    .then((payload) => {
      const ttlMs = streamCacheTtlMs(payload.url);
      const cachedPayload = {
        ...payload,
        cache_expires_at_ms: Date.now() + ttlMs
      };
      resolveCache.set(cacheKey, cachedPayload, ttlMs);
      scheduleSaveDiskCache();
      console.log(`[youtube-bridge] resolve completed ${videoId} client=${requestedClient} elapsed_ms=${Math.round(performance.now() - startedAt)} ttl_ms=${Math.round(ttlMs)} cache_entries=${resolveCache.size}`);
      return cachedPayload;
    })
    .finally(() => pendingResolutions.delete(cacheKey));
  pendingResolutions.set(cacheKey, resolution);
  return resolution;
}

function invalidateResolution(body) {
  const videoId = body.video_id || extractVideoId(body.url);
  if (!videoId) throw new Error('Invalid YouTube URL or video ID');
  const requestedClient = body.client === 'YTMUSIC' ? 'YTMUSIC' : 'MWEB';
  const cacheKey = `${cookieFileKey(body.cookie_file)}:${requestedClient}:${videoId}`;
  resolveCache.delete(cacheKey);
  pendingResolutions.delete(cacheKey);
  console.log(`[youtube-bridge] resolve cache invalidated ${videoId} client=${requestedClient}`);
  return { invalidated: true };
}

async function resolveTrackUncached(body, videoId, requestedClient) {
  const context = await getSession(body.cookie_file);

  const { info, format, client } = await resolveFormat(context, videoId, requestedClient, {
    type: 'audio',
    quality: 'best',
    format: 'any'
  });

  const metadata = infoPayload(info, videoId);
  return {
    ...metadata,
    ...formatPayload(format),
    client,
    format: 'mp3',
    http_headers: { 'User-Agent': USER_AGENT }
  };
}

async function getInfo(body) {
  const videoId = body.video_id || extractVideoId(body.url);
  if (!videoId) throw new Error('Invalid YouTube URL or video ID');
  const context = await getSession(body.cookie_file);
  const client = body.client === 'YTMUSIC' ? 'YTMUSIC' : 'MWEB';
  const poToken = await getPoToken(context.poBinding || videoId);
  const info = await getPlayableInfo(context.session, videoId, client, poToken);
  return {
    ...infoPayload(info, videoId),
    playability_status: info?.playability_status?.status || '',
    playability_reason: info?.playability_status?.reason || ''
  };
}

async function getWebSession(cookieFile) {
  const cookie = await netscapeCookiesToHeader(cookieFile);
  return await Innertube.create({
    cookie: cookie || undefined,
    user_agent: USER_AGENT,
    client_type: ClientType.WEB,
    cache: new UniversalCache(true),
    enable_session_cache: true,
    generate_session_locally: true,
    retrieve_player: false
  });
}

async function getPlaylist(body) {
  const session = await getWebSession(body.cookie_file);
  const playlistId = body.playlist_id || (await extractPlaylistId(body.url, session));
  if (!playlistId) throw new Error('Invalid YouTube playlist URL or ID');
  const playlist = await session.getPlaylist(playlistId);
  const allItems = [...(playlist?.items || playlist?.videos || [])];

  let current = playlist;
  while (current?.has_continuation) {
    try {
      current = await current.getContinuation();
      const pageItems = current?.items || current?.videos || [];
      if (!pageItems.length) break;
      allItems.push(...pageItems);
    } catch (error) {
      console.warn(`[youtube-bridge] Playlist pagination completed or stopped: ${error.message}`);
      break;
    }
  }

  console.log(`[youtube-bridge] playlist ${playlistId} fetched ${allItems.length} total items across all pages`);

  const defaultUploader = textValue(playlist?.info?.author?.name) || textValue(playlist?.info?.title) || '';

  return {
    id: playlistId,
    title: textValue(playlist?.info?.title),
    uploader: defaultUploader,
    entries: allItems.map((item) => {
      let id = item.id || item.video_id || item.content_id;
      if (!id || id.length !== 11) {
        const str = JSON.stringify(item);
        const match = str.match(/"videoId"\s*:\s*"([A-Za-z0-9_-]{11})"/);
        if (match) id = match[1];
      }
      const title = textValue(item.title?.text || item.title || item.metadata?.title?.text || item.metadata?.title);
      const uploader = textValue(item.author?.name || item.author?.text || item.author || item.metadata?.author?.name || item.short_by_line_text) || defaultUploader;
      return {
        id,
        videoId: id,
        title,
        uploader,
        webpage_url: id ? `https://www.youtube.com/watch?v=${id}` : ''
      };
    }).filter((item) => item.id && item.id.length === 11)
  };
}

async function searchVideos(body) {
  const query = String(body.query || '').trim();
  if (!query) throw new Error('Search query is required');
  const limit = Math.min(Math.max(Number(body.limit) || 10, 1), 50);
  const mode = body.mode === 'music' ? 'music' : 'video';
  const startedAt = performance.now();
  const cacheKey = normalizeSearchKey(mode, query);
  const cached = searchCache.get(cacheKey);
  if (cached) {
    console.log(`[youtube-bridge] search cache hit mode=${mode} query="${query}" elapsed_ms=${Math.round(performance.now() - startedAt)}`);
    return { entries: cached.slice(0, limit) };
  }

  const entries = await searchCache.getOrCreate(cacheKey, SEARCH_CACHE_TTL_MS, async () => {
    const session = await getSearchSession();
    try {
      if (mode === 'music') {
        const rawRes = await session.actions.execute('/search', {
          query,
          params: 'Eg-KAQwIARAAGAAgACgAMABqChAEEAMQCRAFEAo%3D',
          client: 'YTMUSIC'
        });
        const tab = rawRes.data?.contents?.tabbedSearchResultsRenderer?.tabs?.[0]?.tabRenderer;
        const sections = tab?.content?.sectionListRenderer?.contents || [];
        const ytmEntries = [];
        for (const sec of sections) {
          const items = sec?.musicShelfRenderer?.contents || sec?.musicCardShelfRenderer?.contents || [];
          for (const item of items) {
            const r = item?.musicResponsiveListItemRenderer;
            if (!r) continue;
            const flexCols = r.flexColumns || [];
            const title = flexCols[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs?.[0]?.text;
            const artist = flexCols[1]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs?.[0]?.text;
            const videoId = r.playlistItemData?.videoId || r.overlay?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer?.playNavigationEndpoint?.watchEndpoint?.videoId;
            if (videoId) {
              ytmEntries.push({
                id: videoId,
                videoId,
                title: title || 'Unknown Title',
                uploader: artist || '',
                webpage_url: `https://www.youtube.com/watch?v=${videoId}`
              });
            }
          }
        }
        if (ytmEntries.length > 0) return ytmEntries.slice(0, 50);
      } else {
        const rawRes = await session.actions.execute('/search', {
          query,
          params: 'EgIQAQ%3D%3D',
          client: 'WEB'
        });
        const ytContents = rawRes.data?.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents || [];
        const ytEntries = [];
        for (const sec of ytContents) {
          const items = sec?.itemSectionRenderer?.contents || [];
          for (const item of items) {
            const v = item?.videoRenderer;
            if (!v || !v.videoId) continue;
            const title = v.title?.runs?.[0]?.text || v.title?.simpleText;
            const uploader = v.ownerText?.runs?.[0]?.text || v.shortBylineText?.runs?.[0]?.text;
            ytEntries.push({
              id: v.videoId,
              videoId: v.videoId,
              title: title || 'Unknown Title',
              uploader: uploader || '',
              webpage_url: `https://www.youtube.com/watch?v=${v.videoId}`
            });
          }
        }
        if (ytEntries.length > 0) return ytEntries.slice(0, 50);
      }
    } catch (rawErr) {
      console.warn(`[youtube-bridge] Fast raw search failed for "${query}", falling back to parser:`, rawErr.message);
    }

    if (mode === 'music') {
      const search = await session.music.search(query, { type: 'song' });
      const items = search?.songs?.contents || search?.contents || [];
      return items
        .map(musicItemPayload)
        .filter(Boolean)
        .slice(0, 50);
    }
    const search = await session.search(query, { type: 'video' });
    const items = search?.videos || search?.results || search?.contents || [];
    return items.slice(0, 50).map((video) => ({
      id: video.id || video.videoId,
      videoId: video.id || video.videoId,
      title: textValue(video.title),
      uploader: textValue(video.author?.name || video.author?.text || video.author),
      webpage_url: (video.id || video.videoId) ? `https://www.youtube.com/watch?v=${video.id || video.videoId}` : ''
    })).filter((video) => video.id);
  });
  console.log(`[youtube-bridge] searched mode=${mode} query="${query}" in ${Math.round(performance.now() - startedAt)}ms cache_entries=${searchCache.size}`);
  scheduleSaveDiskCache();

  const results = entries.slice(0, limit);
  if (limit === 1 && results.length > 0) {
    const topVideoId = results[0].videoId || results[0].id;
    if (topVideoId) {
      const requestedClient = mode === 'music' ? 'YTMUSIC' : 'MWEB';
      const cacheKey = `${cookieFileKey(body.cookie_file)}:${requestedClient}:${topVideoId}`;
      const cached = resolveCache.get(cacheKey);
      if (cached && cached.url) {
        results[0] = {
          ...results[0],
          ...cached,
          stream_url: cached.url
        };
      } else {
        try {
          const resolved = await resolveTrack({
            video_id: topVideoId,
            client: requestedClient,
            cookie_file: body.cookie_file
          });
          if (resolved && resolved.url) {
            results[0] = {
              ...results[0],
              ...resolved,
              stream_url: resolved.url
            };
          }
        } catch (err) {
          console.warn(`[youtube-bridge] pre-resolve in search failed for ${topVideoId}: ${err.message}`);
        }
      }
    }
  }

  return { entries: results };
}

async function getMusicRecommendations(body) {
  const videoId = body.video_id || extractVideoId(body.url);
  if (!videoId) throw new Error('Invalid YouTube URL or video ID');
  const limit = Math.min(Math.max(Number(body.limit) || 20, 1), 50);
  const cacheKey = `${cookieFileKey(body.cookie_file)}:${videoId}`;
  const startedAt = performance.now();
  const cached = recommendationCache.get(cacheKey);
  if (cached) {
    console.log(`[youtube-bridge] recommendations cache hit ${videoId} elapsed_ms=${Math.round(performance.now() - startedAt)}`);
    return { entries: cached.slice(0, limit) };
  }

  const entries = await recommendationCache.getOrCreate(
    cacheKey,
    RECOMMENDATION_CACHE_TTL_MS,
    async () => {
      const { session } = await getSession(body.cookie_file);
      try {
        const playlist = await session.music.getUpNext(videoId, true);
        return (playlist?.contents || [])
          .map(musicItemPayload)
          .filter((item) => item && item.videoId !== videoId)
          .slice(0, 50);
      } catch (err) {
        console.warn(`[youtube-bridge] getUpNext(automix) failed for ${videoId}: ${err.message}. Retrying standard upNext...`);
        try {
          const fallbackPlaylist = await session.music.getUpNext(videoId, false);
          return (fallbackPlaylist?.contents || [])
            .map(musicItemPayload)
            .filter((item) => item && item.videoId !== videoId)
            .slice(0, 50);
        } catch (fallbackErr) {
          console.warn(`[youtube-bridge] getUpNext fallback failed for ${videoId}: ${fallbackErr.message}`);
          return [];
        }
      }
    }
  );
  console.log(`[youtube-bridge] recommendations completed ${videoId} elapsed_ms=${Math.round(performance.now() - startedAt)} cache_entries=${recommendationCache.size}`);
  return { entries: entries.slice(0, limit) };
}

async function getDownloadPlan(body) {
  const videoId = body.video_id || extractVideoId(body.url);
  if (!videoId) throw new Error('Invalid YouTube URL or video ID');
  const context = await getSession(body.cookie_file);
  const requestedClient = body.client === 'YTMUSIC' ? 'YTMUSIC' : 'MWEB';

  if (!body.video) {
    const { format: audio, client } = await resolveFormat(context, videoId, requestedClient, {
      type: 'audio', quality: 'best', format: 'any'
    });
    return {
      audio: formatPayload(audio),
      client,
      http_headers: { 'User-Agent': USER_AGENT }
    };
  }

  let videoResult;
  try {
    videoResult = await resolveFormat(context, videoId, requestedClient, {
      type: 'video', quality: 'best', format: 'mp4'
    });
  } catch {
    videoResult = await resolveFormat(context, videoId, requestedClient, {
      type: 'video', quality: 'best', format: 'any'
    });
  }

  let audioResult;
  try {
    audioResult = await resolveFormat(context, videoId, requestedClient, {
      type: 'audio', quality: 'best', format: 'mp4'
    });
  } catch {
    audioResult = await resolveFormat(context, videoId, requestedClient, {
      type: 'audio', quality: 'best', format: 'any'
    });
  }

  return {
    video: formatPayload(videoResult.format),
    audio: formatPayload(audioResult.format),
    client: `${videoResult.client}/${audioResult.client}`,
    http_headers: { 'User-Agent': USER_AGENT }
  };
}

// ---------------------------------------------------------------------------
// SABR audio streaming (ttmediabot-sabr-v3).
// Since late November 2026 YouTube often sends no plain googlevideo link for
// a song, only SABR (the protocol YouTube's own web player uses). /resolve
// hands the bot a URL on this bridge, and the bridge fetches the audio over
// SABR with LuanRT's googlevideo package and serves it to mpv like a normal
// file. Set YOUTUBE_BRIDGE_SABR=0 to go back to direct stream URLs only.
// ---------------------------------------------------------------------------
let sabrLib = null;
if (process.env.YOUTUBE_BRIDGE_SABR !== '0') {
  try {
    const streamModule = await import('googlevideo/sabr-stream');
    const utilsModule = await import('googlevideo/utils');
    sabrLib = {
      SabrStream: streamModule.SabrStream,
      buildSabrFormat: utilsModule.buildSabrFormat,
      EnabledTrackTypes: utilsModule.EnabledTrackTypes
    };
    try {
      utilsModule.Logger.getInstance().setLogLevels(utilsModule.LogLevel.ERROR, utilsModule.LogLevel.WARN);
    } catch {}
    console.log('[youtube-bridge] SABR audio streaming enabled (ttmediabot-sabr-v3)');
  } catch (error) {
    sabrLib = null;
    console.warn(`[youtube-bridge] SABR audio streaming unavailable, using direct stream URLs: ${error?.message || error}`);
  }
}

const SABR_MAX_JOBS = 6;
const SABR_ABANDON_MS = 90 * 1000;
const SABR_KEEP_DONE_MS = 20 * 60 * 1000;
const SABR_FIRST_BYTE_TIMEOUT_MS = 45 * 1000;
const SABR_FULL_TIMEOUT_MS = 180 * 1000;
// If YouTube stops sending mid-song, give up after this long. The audio that
// already arrived still plays, then the song ends normally and the bot moves on.
const SABR_STALL_MS = 15 * 1000;
const SABR_MAX_BYTES = 400 * 1024 * 1024;
const sabrJobs = new Map();

function sabrHost(req) {
  const host = String(req.headers.host || '');
  return /^[A-Za-z0-9.-]+(:\d+)?$/.test(host) ? host : `127.0.0.1:${PORT}`;
}

function withSabrUrl(payload, req, body) {
  if (!sabrLib || !payload || payload.is_live) return payload;
  const videoId = String(payload.id || payload.videoId || body.video_id || extractVideoId(body.url) || '');
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) return payload;
  const query = body.bot_id ? `?bot=${encodeURIComponent(body.bot_id)}` : '';
  return {
    ...payload,
    direct_url: payload.url,
    url: `http://${sabrHost(req)}/sabr/${videoId}${query}`,
    stream_transport: 'sabr'
  };
}

async function sabrPlayerRequest(innertube, videoId, reloadPlaybackContext) {
  const endpoint = new YTNodes.NavigationEndpoint({ watchEndpoint: { videoId } });
  const args = {
    playbackContext: {
      contentPlaybackContext: {
        vis: 0,
        splay: false,
        signatureTimestamp: innertube.session.player?.signature_timestamp
      }
    },
    contentCheckOk: true,
    racyCheckOk: true,
    client: 'MWEB'
  };
  if (reloadPlaybackContext) args.playbackContext.reloadPlaybackContext = reloadPlaybackContext;
  return endpoint.call(innertube.actions, { ...args, parse: true });
}

async function sabrStreamingInfo(innertube, playerResponse) {
  const serverAbrStreamingUrl = await innertube.session.player?.decipher(
    playerResponse.streaming_data?.server_abr_streaming_url
  );
  const videoPlaybackUstreamerConfig =
    playerResponse.player_config?.media_common_config?.media_ustreamer_request_config?.video_playback_ustreamer_config;
  return { serverAbrStreamingUrl, videoPlaybackUstreamerConfig };
}

async function mintSabrPoToken(videoId) {
  const token = await getPoToken(videoId);
  if (!token) throw new Error('PO token provider returned no token');
  return new Uint8Array(Buffer.from(token, 'base64url'));
}

function pickSabrAudioFormat(formats) {
  const audio = formats.filter((format) => format.hasAudio && !format.hasVideo);
  const plain = audio.filter((format) => !format.isDrc);
  const pool = plain.length ? plain : audio;
  return pool.find((format) => format.itag === 251)
    || pool.find((format) => format.itag === 140)
    || [...pool].sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
}

async function streamSabrAttempt(job, cookie) {
  const { SabrStream, buildSabrFormat, EnabledTrackTypes } = sabrLib;
  const startedAt = performance.now();
  const innertube = await Innertube.create({
    cookie: cookie || undefined,
    client_type: ClientType.MWEB,
    user_agent: USER_AGENT,
    cache: new UniversalCache(false),
    retrieve_player: true
  });
  const playerResponse = await sabrPlayerRequest(innertube, job.videoId);
  const status = playerResponse.playability_status?.status || 'UNKNOWN';
  if (status !== 'OK') {
    const reason = playerResponse.playability_status?.reason;
    throw new Error(`not playable (${status}${reason ? `: ${reason}` : ''})`);
  }
  const adaptiveFormats = playerResponse.streaming_data?.adaptive_formats || [];
  const { serverAbrStreamingUrl, videoPlaybackUstreamerConfig } = await sabrStreamingInfo(innertube, playerResponse);
  if (!serverAbrStreamingUrl || !videoPlaybackUstreamerConfig) {
    throw new Error('player response has no SABR streaming info');
  }
  const clientName = Number.parseInt(Constants.CLIENT_NAME_IDS[innertube.session.context.client.clientName], 10);
  const clientVersion = innertube.session.context.client.clientVersion;

  const sabr = new SabrStream({
    videoId: job.videoId,
    formats: adaptiveFormats.map(buildSabrFormat),
    serverAbrStreamingUrl,
    videoPlaybackUstreamerConfig,
    clientInfo: { clientName, clientVersion },
    callbacks: {
      onMintPoToken: () => mintSabrPoToken(job.videoId),
      onReloadPlayerResponse: async (context) => {
        const reloaded = await sabrPlayerRequest(innertube, job.videoId, context);
        const info = await sabrStreamingInfo(innertube, reloaded);
        if (!info.serverAbrStreamingUrl || !info.videoPlaybackUstreamerConfig) {
          throw new Error('reloaded player response has no SABR streaming info');
        }
        return info;
      }
    }
  });
  job.sabr = sabr;
  let streamError = null;
  sabr.on('error', (error) => { streamError = error; });

  const { audioStream, selectedFormats } = sabr.start({
    enabledTrackTypes: EnabledTrackTypes.AUDIO_ONLY,
    audioFormat: pickSabrAudioFormat,
    isPostLiveDvr: false,
    maxRetries: 5,
    stallDetectionMs: 30000
  });
  const audioFormat = selectedFormats.audioFormat;
  job.mime = String(audioFormat.mimeType || '').includes('mp4') ? 'audio/mp4' : 'audio/webm';
  job.itag = audioFormat.itag;
  job.expectedLength = Number(audioFormat.contentLength) || 0;
  console.log(`[youtube-bridge] sabr start ${job.videoId} itag=${job.itag} expected_bytes=${job.expectedLength || 'unknown'} setup_ms=${Math.round(performance.now() - startedAt)}`);

  const reader = audioStream.getReader();
  try {
    while (true) {
      if (job.cancelled) throw new Error('cancelled');
      let stallTimer;
      const stalled = new Promise((_, reject) => {
        stallTimer = setTimeout(() => reject(new Error(`no audio data for ${SABR_STALL_MS / 1000}s`)), SABR_STALL_MS);
      });
      let result;
      try {
        result = await Promise.race([reader.read(), stalled]);
      } finally {
        clearTimeout(stallTimer);
      }
      if (result.done) break;
      const value = result.value;
      const chunk = Buffer.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
      if (!chunk.length) continue;
      if (!job.length) job.firstByteMs = Math.round(performance.now() - startedAt);
      job.chunks.push(chunk);
      job.length += chunk.length;
      if (job.length > SABR_MAX_BYTES) throw new Error('audio is larger than the SABR size limit');
      job.emitter.emit('data');
    }
  } catch (error) {
    sabr.abort().catch(() => {});
    throw error;
  } finally {
    try { reader.releaseLock(); } catch {}
  }
  if (job.cancelled) throw new Error('cancelled');
  if (streamError) throw streamError;
  if (!job.length) throw new Error('SABR stream ended without audio');
  if (job.expectedLength && job.length < job.expectedLength * 0.9) {
    throw new Error(`SABR stream ended early (${job.length} of ${job.expectedLength} bytes)`);
  }
}

async function runSabrJob(job) {
  const cookie = await netscapeCookiesToHeader(job.cookieFile).catch(() => '');
  const attempts = cookie ? [['account', cookie], ['anonymous', '']] : [['anonymous', '']];
  let lastError = null;
  for (const [label, attemptCookie] of attempts) {
    if (job.cancelled) break;
    try {
      await streamSabrAttempt(job, attemptCookie);
      job.done = true;
      job.finishedAt = Date.now();
      job.lastAccess = Date.now();
      console.log(`[youtube-bridge] sabr done ${job.videoId} via=${label} bytes=${job.length} expected=${job.expectedLength || 'unknown'} first_byte_ms=${job.firstByteMs} total_ms=${Date.now() - job.createdAt}`);
      job.emitter.emit('end');
      return;
    } catch (error) {
      lastError = error;
      console.warn(`[youtube-bridge] sabr ${job.videoId} via=${label} failed after ${job.length} bytes: ${error?.message || error}`);
      if (job.length > 0 || job.cancelled) break;
    }
  }
  if (!job.error) job.error = lastError || new Error('SABR stream failed');
  job.finishedAt = Date.now();
  job.emitter.emit('failed');
}

function cancelSabrJob(job, reason) {
  if (job.done || job.error) return;
  job.cancelled = true;
  job.error = new Error(reason);
  try { job.sabr?.abort().catch(() => {}); } catch {}
  job.emitter.emit('failed');
}

function pruneSabrJobs(keepKey = null) {
  const now = Date.now();
  for (const [key, job] of sabrJobs) {
    if (key === keepKey || job.listeners > 0) continue;
    const idleMs = now - job.lastAccess;
    if (!job.done && !job.error && idleMs > SABR_ABANDON_MS) {
      cancelSabrJob(job, 'abandoned');
      sabrJobs.delete(key);
    } else if ((job.done || job.error) && idleMs > SABR_KEEP_DONE_MS) {
      sabrJobs.delete(key);
    }
  }
  for (const [key, job] of sabrJobs) {
    if (sabrJobs.size <= SABR_MAX_JOBS) break;
    if (key === keepKey || job.listeners > 0) continue;
    cancelSabrJob(job, 'evicted');
    sabrJobs.delete(key);
  }
}

setInterval(() => pruneSabrJobs(), 30 * 1000).unref();

function getSabrJob(videoId, cookieFile) {
  const key = `${cookieFile || 'anonymous'}:${videoId}`;
  let job = sabrJobs.get(key);
  if (job && job.error) {
    sabrJobs.delete(key);
    job = null;
  }
  if (job) {
    sabrJobs.delete(key);
    sabrJobs.set(key, job);
    job.lastAccess = Date.now();
    return job;
  }
  job = {
    key,
    videoId,
    cookieFile,
    chunks: [],
    length: 0,
    expectedLength: 0,
    mime: 'audio/webm',
    itag: null,
    done: false,
    error: null,
    cancelled: false,
    listeners: 0,
    createdAt: Date.now(),
    lastAccess: Date.now(),
    finishedAt: 0,
    firstByteMs: null,
    sabr: null,
    emitter: new EventEmitter()
  };
  job.emitter.setMaxListeners(0);
  sabrJobs.set(key, job);
  pruneSabrJobs(key);
  runSabrJob(job).catch((error) => {
    if (!job.error) job.error = error;
    job.emitter.emit('failed');
  });
  return job;
}

function waitForSabr(job, predicate, timeoutMs, res) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      job.listeners -= 1;
      job.lastAccess = Date.now();
      job.emitter.off('data', check);
      job.emitter.off('end', check);
      job.emitter.off('failed', check);
      res?.off('close', onClose);
      if (error) reject(error);
      else resolve();
    };
    function check() {
      if (predicate()) finish();
      else if (job.error) finish(job.error);
    }
    function onClose() {
      finish(new Error('client disconnected'));
    }
    job.listeners += 1;
    job.emitter.on('data', check);
    job.emitter.on('end', check);
    job.emitter.on('failed', check);
    res?.on('close', onClose);
    timer = setTimeout(() => finish(new Error('timed out waiting for SABR audio')), timeoutMs);
    check();
  });
}

function pumpSabr(res, job, start, endExclusive) {
  return new Promise((resolve) => {
    const limit = endExclusive ?? Number.POSITIVE_INFINITY;
    let finished = false;
    let waitingForDrain = false;
    let chunkIndex = 0;
    let chunkStart = 0;
    let offset = start;

    const finish = () => {
      if (finished) return;
      finished = true;
      job.listeners -= 1;
      job.lastAccess = Date.now();
      job.emitter.off('data', pump);
      job.emitter.off('end', pump);
      job.emitter.off('failed', pump);
      resolve();
    };

    function pump() {
      if (finished || waitingForDrain) return;
      while (offset < limit) {
        while (chunkIndex < job.chunks.length && chunkStart + job.chunks[chunkIndex].length <= offset) {
          chunkStart += job.chunks[chunkIndex].length;
          chunkIndex += 1;
        }
        if (chunkIndex >= job.chunks.length) break;
        const chunk = job.chunks[chunkIndex];
        const slice = chunk.subarray(offset - chunkStart, Math.min(chunk.length, limit - chunkStart));
        offset += slice.length;
        if (!res.write(slice)) {
          waitingForDrain = true;
          res.once('drain', () => {
            waitingForDrain = false;
            pump();
          });
          return;
        }
      }
      // When the download was cut off, still end cleanly after the audio that did
      // arrive: mpv then finishes the song normally instead of reconnecting and
      // retrying it, and the bot moves on to the next song.
      if (offset >= limit || ((job.done || job.error) && offset >= job.length)) {
        res.end();
        finish();
      }
    }

    job.listeners += 1;
    res.on('close', finish);
    job.emitter.on('data', pump);
    job.emitter.on('end', pump);
    job.emitter.on('failed', pump);
    pump();
  });
}

function parseByteRange(header) {
  if (!header) return null;
  const match = /^bytes=(\d+)-(\d*)$/.exec(String(header).trim());
  if (!match) return null;
  return { start: Number(match[1]), end: match[2] === '' ? null : Number(match[2]) };
}

async function serveSabr(req, res) {
  const requestUrl = new URL(req.url, 'http://bridge.local');
  const match = /^\/sabr\/([A-Za-z0-9_-]{11})$/.exec(requestUrl.pathname);
  if (!match || !sabrLib) return json(res, 404, { error: 'Not found' });
  const videoId = match[1];
  const botId = requestUrl.searchParams.get('bot') || '';
  const cookieFile = botId ? getBotCookieFile(botId) : '';
  const job = getSabrJob(videoId, cookieFile);
  const range = parseByteRange(req.headers.range);
  const start = range ? range.start : 0;
  const end = range ? range.end : null;
  const headOnly = req.method === 'HEAD';

  try {
    if (start > 0 || end !== null) {
      // A Content-Range needs the full size, so wait for the download to finish.
      await waitForSabr(job, () => job.done, SABR_FULL_TIMEOUT_MS, res);
      if (start >= job.length) {
        res.writeHead(416, { 'Content-Range': `bytes */${job.length}` });
        return res.end();
      }
      const last = end === null ? job.length - 1 : Math.min(end, job.length - 1);
      res.writeHead(206, {
        'Content-Type': job.mime,
        'Accept-Ranges': 'bytes',
        'Content-Range': `bytes ${start}-${last}/${job.length}`,
        'Content-Length': last - start + 1
      });
      if (headOnly) return res.end();
      return await pumpSabr(res, job, start, last + 1);
    }

    if (!job.done) {
      await waitForSabr(job, () => job.length > 0 || job.done, SABR_FIRST_BYTE_TIMEOUT_MS, res);
    }
    const headers = { 'Content-Type': job.mime, 'Accept-Ranges': 'bytes' };
    if (job.done) headers['Content-Length'] = job.length;
    res.writeHead(200, headers);
    if (headOnly) return res.end();
    return await pumpSabr(res, job, 0, null);
  } catch (error) {
    const message = error?.message || String(error);
    if (message !== 'client disconnected') {
      console.warn(`[youtube-bridge] sabr serve ${videoId} failed: ${message}`);
    }
    if (!res.headersSent && !res.destroyed) return json(res, 502, { error: message });
    res.destroy();
  }
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/health') {
      return json(res, 200, { ok: true, version: '2' });
    }
    if ((req.method === 'GET' || req.method === 'HEAD') && req.url.startsWith('/sabr/')) {
      return await serveSabr(req, res);
    }
    if (req.method !== 'POST') return json(res, 404, { error: 'Not found' });

    const body = await readBody(req);
    body.cookie_file = getBotCookieFile(body.bot_id);
    if (req.url === '/resolve') return json(res, 200, withSabrUrl(await resolveTrack(body), req, body));
    if (req.url === '/invalidate') return json(res, 200, invalidateResolution(body));
    if (req.url === '/info') return json(res, 200, await getInfo(body));
    if (req.url === '/playlist') return json(res, 200, await getPlaylist(body));
    if (req.url === '/search') return json(res, 200, await searchVideos(body));
    if (req.url === '/recommendations') return json(res, 200, await getMusicRecommendations(body));
    if (req.url === '/download-plan') return json(res, 200, await getDownloadPlan(body));
    if (req.url === '/login-status') return json(res, 200, await getLoginStatus(body));
    return json(res, 404, { error: 'Not found' });
  } catch (error) {
    console.error('[youtube-bridge]', error);
    return json(res, 500, { error: error?.message || String(error) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[youtube-bridge] listening on http://${HOST}:${PORT}`);
  loadDiskCache().catch(() => {});
  // Background pre-warming for search session so first user request is instant
  getSearchSession().catch((err) => {
    console.warn('[youtube-bridge] Background search session warmup failed:', err?.message || err);
  });

  // Keep search socket connections warm periodically
  setInterval(async () => {
    try {
      const session = await getSearchSession();
      await session.music.search('ping', { type: 'song' }).catch(() => {});
    } catch {}
  }, 45000).unref();
});
