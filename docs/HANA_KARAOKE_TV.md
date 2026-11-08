# HANA Karaoke TV receiver

Dedicated URL: `https://dalatgolfvoucher.com/hana_karaoke_tv`. The LG hosted app opens this URL with `?tvapp=1`. The original `hana_karaoke.html`, its JavaScript/CSS, all business pages, Edge functions and database schemas/data are unchanged by this addition.

## Behavior

- Explicit terms/privacy consent and room creation on the TV. No background room creation or Google request before consent.
- QR-only waiting display, then the YouTube IFrame player when a song is current. QR invitation always points to the existing `/hana_karaoke` phone remote; never shares the host capability.
- The TV starts the first queued song through the existing `next` command with `expectedCurrentId: null`. This atomic guard cannot skip a song that another receiver already started or resume a paused current song. Failed automatic starts are not retried continuously for the same revision/entry; manual Play can recover.
- Existing phone reservations, priority-next (never interrupt current), pause, resume and Next continue using the same API. The current item/queue use their existing snapshots and idempotency rules.
- The fullscreen request targets the document rather than just the video, so the QR screen returns after the last song without exiting fullscreen. A local TV gesture may be required by the browser; a phone request cannot provide that gesture. Unsupported fullscreen and autoplay blocking show recovery instructions. Player controls are not covered by custom UI.
- Arrow keys move between visible enabled controls, Enter/OK selects, visible focus border, LG Back (461) opens settings without closing the room. Text-caret editing, native selects and the YouTube iframe's own events are not intercepted. Controls return on keyboard/pointer activity and hide after inactivity.
- No TV power, system-volume control, native YouTube-app control, permanent-room registration or automatic power-on launch is added.

## Fullscreen layout

- The receiver iframe uses the complete available screen, without a fixed 16:9 wrapper or a reserved footer gap. YouTube retains the source video's aspect ratio; the page does not stretch, zoom or crop video or lyrics.
- HANA's fullscreen/settings toolbar is removed from layout when hidden. Successful fullscreen entry and healthy playback hide it immediately. Remote/pointer interaction reveals it briefly; errors and autoplay recovery keep it accessible.
- While the toolbar is visible it temporarily takes its own row outside the player, never an overlay over YouTube controls or advertising. After the toolbar hides the player fills that row as well. The QR waiting screen continues to return inside document fullscreen after the queue ends.

## Scope and updates

Only the new receiver HTML, its three dedicated assets, this documentation and isolated tests are published. The private-install `.ipk` launcher is built separately; no CLI tools, credentials or binary installer is included in the Pages artifact. Later receiver changes take effect after an app reload; launcher/manifest/icon changes require repackaging.

The same existing Supabase resources and YouTube quota apply. No migration, Edge deployment, secret change, access-policy change or existing-row update is needed. Tests intercept external services and use no hosted rooms or search quota.

## Checks

```powershell
$env:PLAYWRIGHT_MODULE='C:/path/to/playwright/index.mjs'
$env:CHROME_PATH='C:/Program Files/Google/Chrome/Application/chrome.exe'
node tests/karaoke-tv-app-browser.mjs
node tests/karaoke-search-browser.mjs
node --check assets/hana-karaoke-tv.js
node --check assets/hana-karaoke-tv-remote.js
```

The separate LG launcher passes official webOS CLI 3.2.6 package validation and 17 isolated contract checks. The receiver passes 61 isolated browser checks. The original karaoke search/browser regression passes 34 checks; unchanged backend regressions pass 40 + 65 + 58 isolated PostgreSQL checks and 63 Edge checks. The receiver test covers keyboard consent/room creation, directional focus, document fullscreen (including preservation while creating a room), full-viewport player geometry at 1280x720, 1914x899 and 1920x1080, immediate toolbar hiding and remote recovery without covering the player, legacy-phone QR join, automatic first song, pause preservation while reserving, priority-next, manual Next, natural song end, repeated-video identities, return to QR, autoplay recovery, Back/settings, reload, fullscreen fallback, bounded failed-start retry and consent revocation. Actual LG 75UR8050PSB/webOS25 video, sound, ads and remote compatibility must still be checked on the physical TV.

## Private TV installation

Use LG Developer Mode and an LG Developer account, pair a PC on the same network, install `com.dalatgolfvoucher.hanakaraoke_1.0.0_all.ipk`, then launch `com.dalatgolfvoucher.hanakaraoke`. The PC does not need to stay on during use. Developer Mode needs periodic renewal; if disabled after expiry, installed developer apps can be removed. Store distribution requires separate LG review.

- [LG hosted web app](https://webostv.developer.lge.com/develop/getting-started/web-app-types)
- [LG Developer Mode](https://webostv.developer.lge.com/develop/getting-started/developer-mode-app)
- [YouTube IFrame API](https://developers.google.com/youtube/iframe_api_reference)
