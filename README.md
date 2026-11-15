# Okazje

A personal price checker: wishlist shop links and OLX searches, checked every 15 minutes, with phone alerts (ntfy) and a short Claude BUY/MAYBE/SKIP opinion.

- **desktop/**: the Mac and Windows app (Electron). It shows the wishlist, sits in the menu bar or tray, starts at login, and runs the checks.
- **web/**: the page itself. The app uses it, and it's also published as the iPhone website on GitHub Pages.
- **supabase/schema.sql**: the cloud database. Paste it into the Supabase SQL Editor once.

Only one computer checks at a time. All data, including the listings already seen, lives in Supabase, so a deal is never flagged twice.

## Build
Every push to main that changes the app runs "Build apps", which makes `Okazje-x.y.z-universal.dmg` and `Okazje Setup x.y.z.exe` and attaches them to a new release (Releases > latest).
