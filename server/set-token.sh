#!/usr/bin/env bash
# Saves a Claude token (from `claude setup-token` on the Mac) for the home server, then tests it.
ENV="$HOME/.okazje/env"
echo "Paste the token now (it stays invisible), then press Enter:"
read -rs T </dev/tty; echo
T="$(printf '%s' "$T" | tr -d '[:space:]')"
case "$T" in sk-ant-oat*) ;; *) echo "That doesn't look like a token (it should start with sk-ant-oat). Nothing saved."; exit 1;; esac
grep -v '^CLAUDE_CODE_OAUTH_TOKEN=' "$ENV" > "$ENV.tmp"; printf 'CLAUDE_CODE_OAUTH_TOKEN=%s\n' "$T" >> "$ENV.tmp"; mv "$ENV.tmp" "$ENV"; chmod 600 "$ENV"
echo "Saved. Testing Claude..."
cd /tmp && echo "Reply with just OK" | CLAUDE_CODE_OAUTH_TOKEN="$T" ~/.local/bin/claude -p --model haiku
echo "Restarting the checker (PC password):"
sudo systemctl restart okazje && echo "Done."
