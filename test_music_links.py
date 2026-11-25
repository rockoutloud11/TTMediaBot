import json
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import Mock

from bot import errors
from bot.modules import music_links
from bot.modules.music_links import MusicTrack
from bot.modules.streamer import Streamer
from bot.player.enums import TrackType
from bot.services.ytm import YtmService


def spotify_page(entity):
    data = {"props": {"pageProps": {"state": {"data": {"entity": entity}}}}}
    return f'<html><script id="__NEXT_DATA__" type="application/json">{json.dumps(data)}</script></html>'


class FakeResponse:
    def __init__(self, text="", data=None, url=""):
        self.text = text
        self._data = data
        self.url = url

    def raise_for_status(self):
        pass

    def json(self):
        return self._data

    def close(self):
        pass


class FakeSession:
    def __init__(self, routes):
        self.routes = routes
        self.requested = []

    def get(self, url, **kwargs):
        self.requested.append(url)
        for key, response in self.routes.items():
            if url.startswith(key):
                return response
        raise AssertionError(f"unexpected request {url}")


class IsMusicLinkTest(TestCase):
    def test_recognises_supported_links(self):
        for url in (
            "https://open.spotify.com/track/abc",
            "https://spotify.link/xyz",
            "https://www.deezer.com/us/track/1",
            "https://link.deezer.com/s/xyz",
        ):
            self.assertTrue(music_links.is_music_link(url), url)

    def test_ignores_everything_else(self):
        for url in (
            "https://www.youtube.com/watch?v=1",
            "https://example.com/open.spotify.com/track/1",
            "open.spotify.com/track/1",
            "war pigs",
            "",
        ):
            self.assertFalse(music_links.is_music_link(url), url)


class SpotifyTest(TestCase):
    def test_track(self):
        page = spotify_page({"title": "Never Gonna Give You Up", "artists": [{"name": "Rick Astley"}]})
        session = FakeSession({"https://open.spotify.com/embed/track/4u": FakeResponse(page)})
        link = music_links.lookup("https://open.spotify.com/intl-de/track/4u?si=1", session)
        self.assertEqual(link.kind, "track")
        self.assertEqual(link.tracks, [MusicTrack("Never Gonna Give You Up", "Rick Astley")])

    def test_album_uses_first_artist_and_skips_empty(self):
        page = spotify_page({
            "title": "Album",
            "trackList": [
                {"title": "One", "subtitle": "A,\xa0B", "entityType": "track"},
                {"title": "", "subtitle": "X"},
                {"title": "Two", "subtitle": "A"},
            ],
        })
        session = FakeSession({"https://open.spotify.com/embed/album/al1": FakeResponse(page)})
        link = music_links.lookup("https://open.spotify.com/album/al1", session)
        self.assertEqual([t.display for t in link.tracks], ["One - A", "Two - A"])

    def test_playlist_is_capped(self):
        page = spotify_page({
            "title": "Big",
            "trackList": [{"title": f"s{i}", "subtitle": "A"} for i in range(250)],
        })
        session = FakeSession({"https://open.spotify.com/embed/playlist/p": FakeResponse(page)})
        link = music_links.lookup("https://open.spotify.com/playlist/p", session)
        self.assertEqual(len(link.tracks), music_links.MAX_TRACKS)

    def test_short_link_is_followed(self):
        page = spotify_page({"title": "S", "artists": [{"name": "A"}]})
        session = FakeSession({
            "https://spotify.link/abc": FakeResponse(url="https://open.spotify.com/track/t1?si=2"),
            "https://open.spotify.com/embed/track/t1": FakeResponse(page),
        })
        link = music_links.lookup("https://spotify.link/abc", session)
        self.assertEqual(link.tracks[0].display, "S - A")

    def test_unreadable_page_and_unsupported_path(self):
        session = FakeSession({"https://open.spotify.com/embed/track/t": FakeResponse("<html></html>")})
        with self.assertRaises(errors.ServiceError):
            music_links.lookup("https://open.spotify.com/track/t", session)
        with self.assertRaises(errors.ServiceError):
            music_links.lookup("https://open.spotify.com/user/someone", session)


class DeezerTest(TestCase):
    def test_track(self):
        session = FakeSession({"https://api.deezer.com/track/3135556": FakeResponse(
            data={"title": "HBFS", "artist": {"name": "Daft Punk"}})})
        link = music_links.lookup("https://www.deezer.com/en/track/3135556", session)
        self.assertEqual(link.tracks, [MusicTrack("HBFS", "Daft Punk")])

    def test_album_and_playlist(self):
        tracks = {"data": [{"title": "One", "artist": {"name": "A"}}, {"title": "Two", "artist": {"name": "B"}}]}
        session = FakeSession({
            "https://api.deezer.com/album/9/tracks": FakeResponse(data=tracks),
            "https://api.deezer.com/album/9": FakeResponse(data={"title": "Alb"}),
            "https://api.deezer.com/playlist/7/tracks": FakeResponse(data=tracks),
            "https://api.deezer.com/playlist/7": FakeResponse(data={"title": "Pl"}),
        })
        album = music_links.lookup("https://www.deezer.com/album/9", session)
        playlist = music_links.lookup("https://www.deezer.com/fr/playlist/7", session)
        self.assertEqual([t.display for t in album.tracks], ["One - A", "Two - B"])
        self.assertEqual(playlist.name, "Pl")

    def test_missing_item(self):
        session = FakeSession({"https://api.deezer.com/track/5": FakeResponse(data={"error": {"code": 800}})})
        with self.assertRaises(errors.ServiceError):
            music_links.lookup("https://www.deezer.com/track/5", session)


class QueryTest(TestCase):
    def test_extras_are_dropped_from_the_search(self):
        self.assertEqual(MusicTrack("Flower (feat. SZA) [From GTAVI]", "Justice").query, "Justice Flower")
        self.assertEqual(MusicTrack("Never Gonna Give You Up - 2022 Remaster", "Rick Astley").query,
                         "Rick Astley Never Gonna Give You Up")
        self.assertEqual(MusicTrack("Plain", "").query, "Plain")
        self.assertEqual(MusicTrack("(Untitled)", "Band").query, "Band (Untitled)")


class StreamerTest(TestCase):
    def make(self, services):
        streamer = Streamer.__new__(Streamer)
        streamer.allowed_schemes = ["http", "https"]
        streamer.service_manager = SimpleNamespace(services=services)
        return streamer

    def test_link_becomes_lazy_youtube_tracks(self):
        streamer = self.make({"yt": SimpleNamespace(name="yt", is_enabled=True),
                              "ytm": SimpleNamespace(name="ytm", is_enabled=True)})
        original = music_links.lookup
        music_links.lookup = lambda url: music_links.MusicLink(
            "album", "Alb", [MusicTrack("One", "A"), MusicTrack("Two (live)", "B")])
        try:
            tracks = streamer.get("https://open.spotify.com/album/x", False)
        finally:
            music_links.lookup = original
        self.assertEqual([t.name for t in tracks], ["One - A", "Two (live) - B"])
        self.assertTrue(all(t.service == "ytm" and t.type == TrackType.Dynamic for t in tracks))
        self.assertEqual(tracks[1].extra_info["search_query"], "B Two")

    def test_falls_back_to_yt_and_fails_without_any(self):
        original = music_links.lookup
        music_links.lookup = lambda url: music_links.MusicLink("track", "T", [MusicTrack("T", "A")])
        try:
            only_yt = self.make({"ytm": SimpleNamespace(name="ytm", is_enabled=False),
                                 "yt": SimpleNamespace(name="yt", is_enabled=True)})
            self.assertEqual(only_yt.get("https://www.deezer.com/track/1", False)[0].service, "yt")
            none = self.make({"ytm": SimpleNamespace(name="ytm", is_enabled=False)})
            with self.assertRaises(errors.ServiceError):
                none.get("https://www.deezer.com/track/1", False)
        finally:
            music_links.lookup = original


class YtmLookupTest(TestCase):
    def make_service(self, found):
        service = YtmService.__new__(YtmService)
        service.name = "ytm"
        service.bot = SimpleNamespace(
            translator=SimpleNamespace(translate=lambda t: t),
            player=SimpleNamespace(is_playlist=True, track_list=[], track_index=0),
        )
        service._bridge = Mock()
        service._bridge.find_video_id.return_value = found
        service._bridge.resolve.return_value = {"url": "https://audio.test/x", "title": "Song", "id": "vid123"}
        return service

    def test_search_query_is_looked_up_then_resolved(self):
        service = self.make_service("vid123")
        info = {"search_query": "A One", "title": "One"}
        track = service.get("", extra_info=info, process=True)[0]
        service._bridge.find_video_id.assert_called_once_with("A One", mode="music")
        service._bridge.resolve.assert_called_once_with(url="", video_id="vid123")
        self.assertEqual(track.url, "https://audio.test/x")

    def test_no_match_is_a_service_error(self):
        service = self.make_service("")
        with self.assertRaises(errors.ServiceError):
            service.get("", extra_info={"search_query": "nothing"}, process=True)
        service._bridge.resolve.assert_not_called()


class PlayCommandLinkTest(TestCase):
    def test_p_with_a_music_link_plays_it_like_u(self):
        from bot.commands import user_commands

        calls = []
        original = user_commands.PlayUrlCommand.__call__
        user_commands.PlayUrlCommand.__call__ = lambda self, arg, user: calls.append(arg) or "ok"
        try:
            processor = SimpleNamespace(
                bot=None, cache=None, cache_manager=None, config=None, config_manager=None,
                module_manager=None, player=None, service_manager=None,
                task_processor=None, ttclient=None,
                translator=SimpleNamespace(translate=lambda t: t),
            )
            command = user_commands.PlayPauseCommand(processor)
            result = command(" https://open.spotify.com/track/abc ", SimpleNamespace(id=1))
        finally:
            user_commands.PlayUrlCommand.__call__ = original
        self.assertEqual(result, "ok")
        self.assertEqual(calls, ["https://open.spotify.com/track/abc"])
