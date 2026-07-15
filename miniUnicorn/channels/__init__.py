"""Chat channels module with plugin architecture."""

from miniUnicorn.channels.base import BaseChannel
from miniUnicorn.channels.manager import ChannelManager

__all__ = ["BaseChannel", "ChannelManager"]
