"""Warns the bot's admins when YouTube stops accepting the bot's cookies.

When the cookies stop working, YouTube quietly treats the bot as signed out:
songs fail instantly or stop after about a minute, and nothing in TeamTalk says
why. This checks the login through the YouTube bridge (one request to
youtube.com, at most every 30 minutes) and sends a private message to every
online admin when the login is lost, and again when it works again.
"""
from __future__ import annotations

import logging
import threading
from typing import TYPE_CHECKING, Any, Optional

from bot import errors
from bot.services.youtube_bridge import YouTubeBridge

if TYPE_CHECKING:
    from bot import Bot

FIRST_CHECK_DELAY_SECONDS = 90
CHECK_INTERVAL_SECONDS = 30 * 60

SERVER_ADMIN_USER_TYPE = 2
SIGNED_IN = "in"
SIGNED_OUT = "out"


def _text(value: Any) -> str:
    if isinstance(value, bytes):
        return value.decode("utf-8", "replace")
    return str(value)


class YouTubeLoginWatch:
    def __init__(self, bot: Bot) -> None:
        self._bot = bot
        self._stop = threading.Event()
        self._lock = threading.Lock()
        self._thread: Optional[threading.Thread] = None
        self._state: Optional[str] = None
        self._warning_delivered = False
        self._bridge: Optional[YouTubeBridge] = None

    @property
    def translator(self):
        return self._bot.translator

    def start(self) -> None:
        if self._thread is not None:
            return
        self._thread = threading.Thread(
            target=self._run, name="YouTubeLoginWatch", daemon=True
        )
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()

    def _youtube_enabled(self) -> bool:
        for name in ("ytm", "yt"):
            try:
                self._bot.service_manager.get_service_by_name(name)
                return True
            except errors.ServiceError:
                continue
            except Exception:  # noqa: BLE001
                continue
        return False

    def _run(self) -> None:
        if self._stop.wait(FIRST_CHECK_DELAY_SECONDS):
            return
        while not self._stop.is_set():
            try:
                if self._youtube_enabled():
                    self.check()
            except Exception:  # noqa: BLE001
                logging.exception("YouTube login watch: check failed")
            if self._stop.wait(CHECK_INTERVAL_SECONDS):
                return

    def check(self, force: bool = False, asked_by_admin: bool = False) -> Optional[dict]:
        """Checks the login and warns admins if it changed.

        Returns the bridge's answer, or None if the bridge could not be asked.
        """
        if self._bridge is None:
            self._bridge = YouTubeBridge()
        try:
            status = self._bridge.login_status(force=force)
        except errors.ServiceError as exc:
            logging.warning(f"YouTube login watch: could not check the login: {exc}")
            return None
        with self._lock:
            self._handle(status, asked_by_admin)
        return status

    def _handle(self, status: dict, asked_by_admin: bool) -> None:
        if not status.get("cookies"):
            return
        logged_in = status.get("logged_in")
        if logged_in is False:
            if self._state != SIGNED_OUT:
                logging.warning("YouTube login watch: YouTube no longer accepts this bot's cookies")
                self._state = SIGNED_OUT
                self._warning_delivered = False
            if asked_by_admin:
                self._warning_delivered = True
            if not self._warning_delivered:
                sent = self._message_admins(
                    self.translator.translate(
                        "Warning: YouTube no longer accepts this bot's login. Songs may fail or stop after about a minute until the cookies are replaced. Send yl to check again."
                    )
                )
                self._warning_delivered = sent > 0
        elif logged_in is True:
            if self._state == SIGNED_OUT:
                logging.info("YouTube login watch: the login works again")
                if self._warning_delivered and not asked_by_admin:
                    self._message_admins(
                        self.translator.translate("YouTube login is working again.")
                    )
            self._state = SIGNED_IN
            self._warning_delivered = False

    def _message_admins(self, text: str) -> int:
        """Sends text privately to every online admin (bot admin list or server admin account). Returns how many got it."""
        ttclient = self._bot.ttclient
        admins = {name for name in self._bot.config.teamtalk.users.admins}
        try:
            my_id = ttclient.tt.getMyUserID()
            online = ttclient.tt.getServerUsers()
        except Exception:  # noqa: BLE001
            logging.exception("YouTube login watch: could not list online users")
            return 0
        sent = 0
        for tt_user in online:
            if tt_user.nUserID == my_id:
                continue
            # Same rule the commands use: the bot's admin list, or a TeamTalk
            # server admin account (user type 2).
            if (
                _text(tt_user.szUsername) not in admins
                and getattr(tt_user, "uUserType", 0) != SERVER_ADMIN_USER_TYPE
            ):
                continue
            try:
                ttclient.send_message(text, user=tt_user.nUserID)
                sent += 1
            except Exception:  # noqa: BLE001
                logging.exception("YouTube login watch: could not message an admin")
        if sent == 0:
            logging.warning("YouTube login watch: no admin online to warn; will try again on the next check")
        return sent

    def describe(self, status: Optional[dict]) -> str:
        if status is None:
            return self.translator.translate(
                "Could not check the YouTube login right now. The YouTube service may be restarting; try again in a minute."
            )
        if not status.get("cookies"):
            return self.translator.translate("No YouTube cookies are set up for this bot.")
        logged_in = status.get("logged_in")
        if logged_in is True:
            return self.translator.translate("YouTube login: signed in.")
        if logged_in is False:
            return self.translator.translate(
                "YouTube login: signed out. The cookies need replacing."
            )
        return self.translator.translate(
            "Could not tell whether YouTube accepts the login: {error}"
        ).format(error=status.get("error") or "unknown")
