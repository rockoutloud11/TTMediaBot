from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import Mock, patch

from bot import errors
from bot.commands.user_commands import VolumeLevelingCommand
from bot.config.models import PlayerModel
from bot.player import Player


def make_bot(**overrides):
    return SimpleNamespace(
        config=SimpleNamespace(player=PlayerModel(**overrides)),
        cache=None,
        cache_manager=None,
    )


class PlayerLevelingTest(TestCase):
    def build(self, **overrides):
        with patch("bot.player.mpv.MPV") as mpv_class:
            player = Player(make_bot(**overrides))
        return player, mpv_class.call_args.kwargs

    def test_filter_is_on_from_the_start_by_default(self):
        player, options = self.build()
        self.assertTrue(player.volume_leveling)
        self.assertEqual(options["af"], "lavfi=[dynaudnorm=f=500:g=15:p=0.8:m=10]")

    def test_can_start_switched_off(self):
        player, options = self.build(normalize_volume=False)
        self.assertFalse(player.volume_leveling)
        self.assertNotIn("af", options)

    def test_player_options_can_override_the_filter(self):
        _, options = self.build(player_options={"af": "lavfi=[anull]"})
        self.assertEqual(options["af"], "lavfi=[anull]")

    def test_toggling_sets_and_clears_the_mpv_filter(self):
        player, _ = self.build()
        player.set_volume_leveling(False)
        self.assertEqual(player._player.af, "")
        self.assertFalse(player.volume_leveling)
        player.set_volume_leveling(True)
        self.assertEqual(player._player.af, "lavfi=[dynaudnorm=f=500:g=15:p=0.8:m=10]")
        self.assertTrue(player.volume_leveling)

    def test_mpv_refusing_the_filter_is_a_service_error(self):
        player, _ = self.build()

        class Broken:
            @property
            def af(self):
                return ""

            @af.setter
            def af(self, value):
                raise RuntimeError("bad filter")

        player._player = Broken()
        with self.assertRaises(errors.ServiceError):
            player.set_volume_leveling(False)


class FakePlayer:
    def __init__(self, enabled, fail):
        self.volume_leveling = enabled
        self.fail = fail
        self.calls = []

    def set_volume_leveling(self, value):
        self.calls.append(value)
        if self.fail:
            raise errors.ServiceError("x")
        self.volume_leveling = value


class CommandTest(TestCase):
    def make(self, enabled=True, fail=False):
        player = FakePlayer(enabled, fail)
        processor = SimpleNamespace(
            bot=None, cache=None, cache_manager=None, config=None, config_manager=None,
            module_manager=None, player=player, service_manager=None,
            task_processor=None, ttclient=None,
            translator=SimpleNamespace(translate=lambda t: t),
        )
        return VolumeLevelingCommand(processor), player

    def test_no_argument_switches_and_says_which(self):
        command, player = self.make(enabled=True)
        self.assertEqual(command("", None), "Volume leveling is off")
        self.assertFalse(player.volume_leveling)
        self.assertIn("is on", command("", None))
        self.assertTrue(player.volume_leveling)

    def test_on_off_and_status(self):
        command, player = self.make(enabled=False)
        self.assertIn("is on", command("ON", None))
        self.assertEqual(command("off", None), "Volume leveling is off")
        player.calls.clear()
        self.assertEqual(command("status", None), "Volume leveling is off")
        self.assertEqual(player.calls, [])

    def test_bad_argument(self):
        command, _ = self.make()
        with self.assertRaises(errors.InvalidArgumentError):
            command("loud", None)

    def test_failure_is_reported(self):
        command, _ = self.make(fail=True)
        self.assertEqual(command("off", None), "Could not change volume leveling")
