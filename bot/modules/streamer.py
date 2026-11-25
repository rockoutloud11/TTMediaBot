from __future__ import annotations
import os
from typing import TYPE_CHECKING, List
from urllib.parse import urlparse

from bot import errors
from bot.player.enums import TrackType
from bot.player.track import Track
from bot.modules import music_links
from bot.modules.stream_resolvers import StreamResolverRegistry

if TYPE_CHECKING:
    from bot import Bot


class Streamer:
    def __init__(self, bot: Bot):
        self.allowed_schemes: List[str] = ["http", "https", "rtmp", "rtsp"]
        self.config = bot.config
        self.service_manager = bot.service_manager
        self.stream_resolvers = StreamResolverRegistry()

    def _music_link_tracks(self, url: str) -> List[Track]:
        """Spotify/Deezer link: one lazy YouTube track per song behind it.

        Each song is looked up on YouTube when it is about to play, so a whole
        album or playlist can be queued at once without waiting.
        """
        service = None
        for name in ("ytm", "yt"):
            candidate = self.service_manager.services.get(name)
            if candidate is not None and candidate.is_enabled:
                service = candidate
                break
        if service is None:
            raise errors.ServiceError("No YouTube service is available")
        link = music_links.lookup(url)
        return [
            Track(
                service=service.name,
                url="",
                name=song.display,
                type=TrackType.Dynamic,
                extra_info={
                    "search_query": song.query,
                    "title": song.title,
                    "artist": song.artist,
                    "source_url": url,
                },
            )
            for song in link.tracks
        ]

    def get(self, url: str, is_admin: bool) -> List[Track]:
        url = url.strip()
        if music_links.is_music_link(url):
            return self._music_link_tracks(url)
        parsed_url = urlparse(url)
        if parsed_url.scheme in self.allowed_schemes:
            track = Track(url=url, type=TrackType.Direct)
            fetched_data = [track]
            service_matched = False
            for service in self.service_manager.services.values():
                if parsed_url.hostname not in service.hostnames:
                    continue
                service_matched = True
                try:
                    fetched_data = service.get(url)
                    break
                except errors.ServiceError:
                    continue
                except Exception:
                    return [track]

            if service_matched:
                if (
                    len(fetched_data) == 1
                    and fetched_data[0].url.startswith(str(track.url))
                ):
                    return [track]
                return fetched_data

            resolution = self.stream_resolvers.resolve(url)
            if resolution:
                return [
                    Track(
                        url=resolution.url,
                        name=resolution.name,
                        format=resolution.format,
                        extra_info={"http_headers": resolution.http_headers or {}},
                        type=TrackType.Direct,
                    )
                ]
            return [track]
        elif is_admin:
            if os.path.isfile(url):
                track = Track(
                    url=url,
                    name=os.path.split(url)[-1],
                    format=os.path.splitext(url)[1],
                    type=TrackType.Local,
                )
                return [
                    track,
                ]
            elif os.path.isdir(url):
                tracks: List[Track] = []
                for path, _, files in os.walk(url):
                    for file in sorted(files):
                        url = os.path.join(path, file)
                        name = os.path.split(url)[-1]
                        format = os.path.splitext(url)[1]
                        track = Track(
                            url=url, name=name, format=format, type=TrackType.Local
                        )
                        tracks.append(track)
                return tracks
            else:
                raise errors.PathNotFoundError("")
        else:
            raise errors.IncorrectProtocolError("")
