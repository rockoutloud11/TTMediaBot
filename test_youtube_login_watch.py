from types import SimpleNamespace
from unittest import TestCase

from bot import errors
from bot.youtube_login_watch import YouTubeLoginWatch

OUT = {"cookies": True, "logged_in": False}
IN = {"cookies": True, "logged_in": True}


class FakeBridge:
    def __init__(self, answers):
        self.answers = list(answers)
        self.forced = []

    def login_status(self, force=False):
        self.forced.append(force)
        answer = self.answers.pop(0)
        if isinstance(answer, Exception):
            raise answer
        return answer


class FakeTT:
    def __init__(self, online):
        self.online = online

    def getMyUserID(self):
        return 1

    def getServerUsers(self):
        return [
            SimpleNamespace(nUserID=uid, szUsername=name, uUserType=2 if name == "serveradmin" else 1)
            for uid, name in self.online
        ]


class FakeTTClient:
    def __init__(self, online):
        self.tt = FakeTT(online)
        self.sent = []

    def send_message(self, text, user=None, type=1):
        self.sent.append((user, text))


def make_watch(answers, online=((1, "bot"), (2, "brice"), (3, "guest"))):
    ttclient = FakeTTClient(list(online))
    bot = SimpleNamespace(
        ttclient=ttclient,
        translator=SimpleNamespace(translate=lambda text: text),
        config=SimpleNamespace(
            teamtalk=SimpleNamespace(users=SimpleNamespace(admins=["brice", "admin"]))
        ),
        service_manager=None,
    )
    watch = YouTubeLoginWatch(bot)
    watch._bridge = FakeBridge(answers)
    return watch, ttclient


class YouTubeLoginWatchTest(TestCase):
    def test_warns_online_admins_once_when_signed_out(self):
        watch, tt = make_watch([OUT, OUT])
        watch.check()
        watch.check()
        self.assertEqual(len(tt.sent), 1)
        self.assertEqual(tt.sent[0][0], 2)
        self.assertIn("no longer accepts", tt.sent[0][1])

    def test_server_admin_accounts_are_warned_too(self):
        watch, tt = make_watch([OUT], online=[(1, "bot"), (5, "serveradmin"), (3, "guest")])
        watch.check()
        self.assertEqual([user for user, _ in tt.sent], [5])

    def test_retries_until_an_admin_is_online(self):
        watch, tt = make_watch([OUT, OUT, OUT], online=[(1, "bot"), (3, "guest")])
        watch.check()
        self.assertEqual(tt.sent, [])
        tt.tt.online.append((4, "admin"))
        watch.check()
        watch.check()
        self.assertEqual([user for user, _ in tt.sent], [4])

    def test_says_when_login_works_again(self):
        watch, tt = make_watch([IN, OUT, IN, IN])
        for _ in range(4):
            watch.check()
        self.assertEqual(len(tt.sent), 2)
        self.assertIn("working again", tt.sent[1][1])

    def test_no_messages_while_signed_in_or_without_cookies(self):
        watch, tt = make_watch([IN, {"cookies": False, "logged_in": None}, IN])
        for _ in range(3):
            watch.check()
        self.assertEqual(tt.sent, [])

    def test_unknown_state_changes_nothing(self):
        watch, tt = make_watch([{"cookies": True, "logged_in": None, "error": "x"}])
        watch.check()
        self.assertEqual(tt.sent, [])

    def test_bridge_down_returns_none(self):
        watch, tt = make_watch([errors.ServiceError("down")])
        self.assertIsNone(watch.check())
        self.assertIn("Could not check", watch.describe(None))

    def test_yl_command_path_does_not_broadcast(self):
        watch, tt = make_watch([OUT, OUT])
        status = watch.check(force=True, asked_by_admin=True)
        self.assertEqual(tt.sent, [])
        self.assertIn("signed out", watch.describe(status))
        self.assertEqual(watch._bridge.forced, [True])
        watch.check()
        self.assertEqual(tt.sent, [])

    def test_describe(self):
        watch, _ = make_watch([])
        self.assertEqual(watch.describe(IN), "YouTube login: signed in.")
        self.assertIn("No YouTube cookies", watch.describe({"cookies": False, "logged_in": None}))
        self.assertIn("HTTP 500", watch.describe({"cookies": True, "logged_in": None, "error": "HTTP 500"}))
