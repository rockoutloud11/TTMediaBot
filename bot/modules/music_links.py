"""Reads Spotify and Deezer links and says which songs are behind them.

Neither site lets the bot play its music, so this only finds out the song
titles and artists (no account or key needed). The bot then looks each song
up on YouTube Music and plays that. Supported: tracks, albums and playlists
(Spotify artist pages give the artist's popular songs).
"""
from __future__ import annotations

from dataclasses import dataclass
import json
import logging
import re
from typing import List, Optional
from urllib.parse import urlparse

import requests

from bot import errors

MAX_TRACKS = 100
TIMEOUT = (5, 15)
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"
)

SPOTIFY_HOSTS = {"open.spotify.com", "play.spotify.com"}
SPOTIFY_SHORT_HOSTS = {"spotify.link", "spotify.app.link"}
DEEZER_HOSTS = {"deezer.com", "www.deezer.com"}
DEEZER_SHORT_HOSTS = {"link.deezer.com", "deezer.page.link"}

SPOTIFY_PATH = re.compile(
    r"^/(?:intl-[a-zA-Z-]+/)?(track|album|playlist|artist)/([A-Za-z0-9]+)"
)
DEEZER_PATH = re.compile(r"^/(?:[a-z]{2}(?:-[a-z]{2})?/)?(track|album|playlist)/(\d+)")


@dataclass(frozen=True)
class MusicTrack:
    title: str
    artist: str

    @property
    def display(self) -> str:
        return f"{self.title} - {self.artist}" if self.artist else self.title

    @property
    def query(self) -> str:
        """What to search for on YouTube: the artist and a tidied title."""
        title = re.sub(r"\s*[\(\[][^\)\]]*[\)\]]", "", self.title)
        title = re.sub(
            r"\s+-\s+.*(remaster|version|edit|mix|live|mono|stereo).*$",
            "",
            title,
            flags=re.I,
        )
        title = _clean(title) or self.title
        return f"{self.artist} {title}".strip()


@dataclass(frozen=True)
class MusicLink:
    kind: str  # "track", "album", "playlist" or "artist"
    name: str
    tracks: List[MusicTrack]


def _host(url: str) -> str:
    try:
        return (urlparse(url).hostname or "").lower()
    except ValueError:
        return ""


def is_music_link(url: str) -> bool:
    parsed = urlparse(url.strip()) if isinstance(url, str) else None
    if not parsed or parsed.scheme not in ("http", "https"):
        return False
    host = (parsed.hostname or "").lower()
    return host in (
        SPOTIFY_HOSTS | SPOTIFY_SHORT_HOSTS | DEEZER_HOSTS | DEEZER_SHORT_HOSTS
    )


def _clean(text: str) -> str:
    return re.sub(r"\s+", " ", (text or "").replace("\xa0", " ")).strip()


def _first_artist(text: str) -> str:
    return _clean((text or "").split(",")[0])


def _get(session: requests.Session, url: str, **kwargs) -> requests.Response:
    try:
        response = session.get(
            url, timeout=TIMEOUT, headers={"User-Agent": USER_AGENT}, **kwargs
        )
        response.raise_for_status()
        return response
    except requests.RequestException as e:
        raise errors.ServiceError(f"Could not read the link: {e}")


def _follow_short_link(session: requests.Session, url: str) -> str:
    response = _get(session, url, allow_redirects=True, stream=True)
    final = response.url
    response.close()
    return final


def lookup(url: str, session: Optional[requests.Session] = None) -> MusicLink:
    """Returns the songs behind a Spotify or Deezer link. Raises ServiceError."""
    session = session or requests.Session()
    url = url.strip()
    host = _host(url)
    if host in SPOTIFY_SHORT_HOSTS | DEEZER_SHORT_HOSTS:
        url = _follow_short_link(session, url)
        host = _host(url)
    path = urlparse(url).path
    if host in SPOTIFY_HOSTS:
        match = SPOTIFY_PATH.match(path)
        if not match:
            raise errors.ServiceError("Unsupported Spotify link")
        return _spotify(session, match.group(1), match.group(2))
    if host in DEEZER_HOSTS:
        match = DEEZER_PATH.match(path)
        if not match:
            raise errors.ServiceError("Unsupported Deezer link")
        return _deezer(session, match.group(1), match.group(2))
    raise errors.ServiceError("Unsupported link")


def _spotify(session: requests.Session, kind: str, item_id: str) -> MusicLink:
    page = _get(session, f"https://open.spotify.com/embed/{kind}/{item_id}").text
    match = re.search(r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>', page, re.S)
    if not match:
        raise errors.ServiceError("Spotify page not understood")
    try:
        entity = json.loads(match.group(1))["props"]["pageProps"]["state"]["data"]["entity"]
    except (KeyError, TypeError, ValueError):
        raise errors.ServiceError("Spotify page not understood")
    name = _clean(entity.get("title") or entity.get("name") or "")
    tracks: List[MusicTrack] = []
    if kind == "track":
        artists = entity.get("artists") or []
        artist = _first_artist(
            ", ".join(a.get("name", "") for a in artists if isinstance(a, dict))
            or entity.get("subtitle")
            or ""
        )
        if name:
            tracks.append(MusicTrack(name, artist))
    else:
        for item in entity.get("trackList") or []:
            title = _clean(item.get("title") or "")
            if not title or item.get("entityType") not in (None, "track"):
                continue
            tracks.append(MusicTrack(title, _first_artist(item.get("subtitle") or "")))
            if len(tracks) >= MAX_TRACKS:
                break
    if not tracks:
        raise errors.ServiceError("No songs found in that Spotify link")
    logging.info(f"Spotify link {kind} {name!r}: {len(tracks)} track(s)")
    return MusicLink(kind, name, tracks)


def _deezer_json(session: requests.Session, path: str) -> dict:
    data = _get(session, f"https://api.deezer.com/{path}").json()
    if isinstance(data, dict) and data.get("error"):
        raise errors.ServiceError("Deezer could not find that link")
    return data


def _deezer(session: requests.Session, kind: str, item_id: str) -> MusicLink:
    tracks: List[MusicTrack] = []
    if kind == "track":
        data = _deezer_json(session, f"track/{item_id}")
        name = _clean(data.get("title") or "")
        if name:
            tracks.append(MusicTrack(name, _clean((data.get("artist") or {}).get("name", ""))))
    else:
        data = _deezer_json(session, f"{kind}/{item_id}")
        name = _clean(data.get("title") or "")
        items = _deezer_json(session, f"{kind}/{item_id}/tracks?limit={MAX_TRACKS}").get("data") or []
        for item in items[:MAX_TRACKS]:
            title = _clean(item.get("title") or "")
            if title:
                tracks.append(
                    MusicTrack(title, _clean((item.get("artist") or {}).get("name", "")))
                )
    if not tracks:
        raise errors.ServiceError("No songs found in that Deezer link")
    logging.info(f"Deezer link {kind} {name!r}: {len(tracks)} track(s)")
    return MusicLink(kind, name, tracks)
