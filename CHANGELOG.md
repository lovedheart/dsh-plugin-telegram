# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Breaking Changes
None

### Added
- Full Telegram Bot API client with long-polling support
- Agent integration: inject Telegram messages into DSH agent loop
- Six tools: send_message, send_photo, send_document, edit_message, delete_message, get_info, get_updates
- Automatic reconnection with exponential backoff for network and API errors
- Rate limit handling compliant with Telegram API
- Message chunking for content exceeding Telegram's 4096-char limit
- Markdown to Telegram HTML conversion
- Multi-source bot token resolution: config → env → DSH credentials → file fallback
- Access control via `allowedChats`, `allowedUsers`, and `requireMention`

### Changed
None

### Fixed
- Conflict detection now checks `err.details` in addition to `err.message` (409 Conflict)
- API server errors (502/503/504) now trigger exponential backoff instead of immediate retry
- YAML credential parsing now strips quotes from token values

### Known Limitations
- Single-agent assumption: messages are injected into `agents.list()[0]`
- Agent may not always call `telegram_send_message` tool; model function-calling support varies
- `Config.validate` does not check for unknown keys (only validates known types)

---

## [0.1.0] - 2025-01-15

### Initial Release
- Telegram Bot integration for DSH (DeepSeek Harness)
- Based on QwenPaw's TelegramChannel, adapted for Cordis plugin framework
- 6 tools registered via `ctx.tools.register()`
- Background poller with automatic reconnection
- Agent message injection via `inbox.append()` and `wakeDriver()`
