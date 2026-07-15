"""Message bus module for decoupled channel-agent communication."""

from miniUnicorn.bus.events import InboundMessage, OutboundMessage
from miniUnicorn.bus.queue import MessageBus

__all__ = ["MessageBus", "InboundMessage", "OutboundMessage"]
