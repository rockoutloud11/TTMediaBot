from types import SimpleNamespace
from unittest import TestCase

from bot import errors
from bot.commands.user_commands import QueueAddCommand
from bot.player.enums import State


class FakeQueue:
    def __init__(self, existing=0):
        self.items = [f"old{i}" for i in range(existing)]

    def add(self, track):
        self.items.append(track)
        return len(self.items)


class FakePlayer:
    def __init__(self, state, existing=0):
        self.state = state
        self.queue = FakeQueue(existing)
        self.played = []

    def play(self, tracks, timing_context=None):
        self.played.append(list(tracks))


class FakeTasks:
    def __init__(self):
        self.task_queue = self

    def put(self, task):
        task.function(*task.args, **task.kwargs)

    def qsize(self):
        return 0


def track(name):
    return SimpleNamespace(name=name)


def make_command(state=State.Playing, existing=0, results=None, stream=None, search=None):
    player = FakePlayer(state, existing)
    sent = []
    service = SimpleNamespace(
        name="ytm",
        search=lambda query, limit=None: search(query) if search else [track(f"top:{query}")],
    )
    processor = SimpleNamespace(
        bot=None,
        cache=None,
        cache_manager=None,
        config=SimpleNamespace(general=SimpleNamespace(send_channel_messages=False)),
        config_manager=None,
        module_manager=SimpleNamespace(
            streamer=SimpleNamespace(get=stream or (lambda url, is_admin: [track(url)]))
        ),
        player=player,
        service_manager=SimpleNamespace(service=service),
        task_processor=FakeTasks(),
        ttclient=SimpleNamespace(send_message=lambda *a, **k: sent.append(a)),
        translator=SimpleNamespace(translate=lambda text: text),
        pending_search_results={7: results} if results is not None else {},
    )
    command = QueueAddCommand(processor)
    user = SimpleNamespace(id=7, nickname="Brice", is_admin=False)
    return command, player, user, processor


class QueueAddTest(TestCase):
    def test_number_adds_that_search_result_and_keeps_the_list(self):
        results = [track("one"), track("two"), track("three")]
        command, player, user, processor = make_command(results=results)
        self.assertEqual(command("2", user), "Added to queue [1]: two")
        self.assertEqual(command("3", user), "Added to queue [2]: three")
        self.assertEqual([t.name for t in player.queue.items], ["two", "three"])
        self.assertIn(7, processor.pending_search_results)

    def test_number_out_of_range_or_without_list_searches(self):
        command, player, user, _ = make_command(results=[track("one")])
        command("1999", user)
        self.assertEqual(player.queue.items[0].name, "top:1999")
        command, player, user, _ = make_command()
        command("3", user)
        self.assertEqual(player.queue.items[0].name, "top:3")

    def test_url_is_queued_not_played(self):
        command, player, user, _ = make_command(existing=2)
        reply = command("https://www.youtube.com/watch?v=03hGi0_r0xc", user)
        self.assertEqual(reply, "Added to queue [3]: https://www.youtube.com/watch?v=03hGi0_r0xc")
        self.assertEqual(player.played, [])

    def test_playlist_url_queues_every_track(self):
        playlist = [track("a"), track("b"), track("c")]
        command, player, user, _ = make_command(stream=lambda url, is_admin: playlist)
        reply = command("https://youtube.com/playlist?list=X", user)
        self.assertEqual(reply, "Added 3 tracks to the queue, positions 1 to 3")
        self.assertEqual([t.name for t in player.queue.items], ["a", "b", "c"])

    def test_playlist_url_when_stopped_plays_first_and_queues_rest(self):
        playlist = [track("a"), track("b"), track("c")]
        command, player, user, _ = make_command(state=State.Stopped, stream=lambda url, is_admin: playlist)
        reply = command("https://youtube.com/playlist?list=X", user)
        self.assertEqual(reply, "Playing a. Added 2 more to the queue")
        self.assertEqual([[t.name for t in p] for p in player.played], [["a"]])
        self.assertEqual([t.name for t in player.queue.items], ["b", "c"])

    def test_search_when_stopped_plays_immediately(self):
        command, player, user, _ = make_command(state=State.Stopped)
        self.assertEqual(command("war pigs", user), "Playing top:war pigs")
        self.assertEqual(player.queue.items, [])

    def test_bad_url_messages(self):
        def boom(url, is_admin):
            raise errors.ServiceError("x")
        command, player, user, _ = make_command(stream=boom)
        self.assertEqual(command("https://example.com/x", user), "Cannot process stream URL")
        command, player, user, _ = make_command(stream=lambda url, is_admin: [])
        self.assertEqual(command("https://example.com/x", user), "Nothing is found for your query")

    def test_empty_argument(self):
        command, player, user, _ = make_command()
        with self.assertRaises(errors.InvalidArgumentError):
            command("  ", user)
