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

    def track(self, loudness):
        return SimpleNamespace(extra_info={"loudness_db": loudness})

    def test_leveling_is_on_from_the_start_by_default(self):
        player, options = self.build()
        self.assertTrue(player.volume_leveling)
        self.assertEqual(options["replaygain"], "track")
        self.assertEqual(options["replaygain_fallback"], 0)
        self.assertNotIn("af", options)

    def test_can_start_switched_off(self):
        player, options = self.build(normalize_volume=False)
        self.assertFalse(player.volume_leveling)
        self.assertEqual(options["replaygain"], "no")
        self.assertEqual(player._leveling_gain_db(self.track(5.0)), 0.0)

    def test_loud_songs_are_turned_down_by_their_loudness(self):
        player, _ = self.build()
        self.assertAlmostEqual(player._leveling_gain_db(self.track(3.5)), -3.5)
        self.assertAlmostEqual(player._leveling_gain_db(self.track("6.25")), -6.25)

    def test_quiet_songs_are_left_alone_unless_boost_is_allowed(self):
        player, _ = self.build()
        self.assertEqual(player._leveling_gain_db(self.track(-4.0)), 0.0)
        boosted, _ = self.build(normalize_max_boost_db=3.0)
        self.assertEqual(boosted._leveling_gain_db(self.track(-4.0)), 3.0)
        self.assertEqual(boosted._leveling_gain_db(self.track(-1.5)), 1.5)

    def test_cut_is_capped(self):
        player, _ = self.build()
        self.assertEqual(player._leveling_gain_db(self.track(40.0)), -15.0)

    def test_unknown_or_bad_values_mean_no_change(self):
        player, _ = self.build()
        for value in (None, "", "loud", float("nan"), True, 500):
            self.assertEqual(player._leveling_gain_db(self.track(value)), 0.0, value)
        self.assertEqual(player._leveling_gain_db(SimpleNamespace(extra_info=None)), 0.0)
        self.assertEqual(player._leveling_gain_db(None), 0.0)

    def test_gain_is_set_on_mpv_for_each_song(self):
        player, _ = self.build()
        player._apply_leveling(self.track(2.0))
        self.assertEqual(player._player.replaygain_fallback, -2.0)
        player._apply_leveling(SimpleNamespace(extra_info={}))
        self.assertEqual(player._player.replaygain_fallback, 0.0)

    def test_player_options_can_override(self):
        _, options = self.build(player_options={"replaygain": "no"})
        self.assertEqual(options["replaygain"], "no")

    def test_toggling_switches_replaygain_and_resets_the_gain(self):
        player, _ = self.build()
        player.track = self.track(4.0)
        player.set_volume_leveling(False)
        self.assertEqual(player._player.replaygain, "no")
        self.assertEqual(player._player.replaygain_fallback, 0.0)
        self.assertFalse(player.volume_leveling)
        player.set_volume_leveling(True)
        self.assertEqual(player._player.replaygain, "track")
        self.assertEqual(player._player.replaygain_fallback, -4.0)

    def test_mpv_refusing_is_a_service_error(self):
        player, _ = self.build()

        class Broken:
            @property
            def replaygain(self):
                return "track"

            @replaygain.setter
            def replaygain(self, value):
                raise RuntimeError("no such option")

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
        self.assertEqual(command("", None), "Volume leveling is off, from the next song")
        self.assertFalse(player.volume_leveling)
        self.assertIn("is on", command("", None))
        self.assertTrue(player.volume_leveling)

    def test_on_off_and_status(self):
        command, player = self.make(enabled=False)
        self.assertIn("is on", command("ON", None))
        self.assertEqual(command("off", None), "Volume leveling is off, from the next song")
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
