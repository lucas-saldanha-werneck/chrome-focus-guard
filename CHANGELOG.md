# Changelog

## 0.2.0
- Also guards the main Chrome (not Beta) in Bash commands: `open -a "Google Chrome"`, `open <url>` with no app (the default browser is the main Chrome), `tell application "Google Chrome" ... activate`, `Application('Google Chrome').activate()` and browser-harness `activate_tab(`. Same one-use approval file.

## 0.1.0
- First version: PreToolUse guard for Bash, Write and Edit; one-use approval file.
