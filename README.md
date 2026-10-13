# Very Good Games

Games to play with your friends over webcam. The home page (`/`) lists the games: no-limit Texas Hold'em at `/poker` and Flohdle (a Wordle clone) at `/wordle`.

## Run it

```
pip install -r requirements.txt
python main.py
```

Open http://localhost:8000 and pick a game from the home page (right now that's Texas Hold'em, at `/poker`). Enter your name, choose **Host a game**, set the blinds, starting stack and turn timer, and send the 5-letter code (or the **Copy invite link** URL) to your friends. Once everyone has joined, press **Start game**.

## Letting friends connect over the internet

Browsers only allow webcam access on `https://` pages (or `localhost`), so friends need an HTTPS address. The easiest way to get one is a free tunnel:

```
# Cloudflare (no account needed)
cloudflared tunnel --url http://localhost:8000

# or ngrok
ngrok http 8000
```

Share the `https://...` URL the tunnel prints. If you already have a certificate, you can serve HTTPS directly instead: `python main.py --ssl-certfile cert.pem --ssl-keyfile key.pem`.

### If someone's video never connects

Video goes straight between players' browsers (WebRTC), not through the server. Most home networks handle that fine with the built-in STUN servers. Strict networks (some corporate, university or mobile ones) need a TURN relay. Set one with an environment variable:

```
set ICE_SERVERS=[{"urls":"stun:stun.l.google.com:19302"},{"urls":"turn:your.turn.server:3478","username":"user","credential":"pass"}]
python main.py
```

Every player sends their video to every other player, so this works best with up to about 6–9 people at the default low resolution (320×240).

## Features

- Lobby codes, invite links, and reconnecting to your seat after a refresh or dropped connection
- Full NLHE rules: heads-up blinds, minimum raises, short all-ins that don't reopen betting, side pots, split pots, and board runouts when everyone is all-in
- Host controls: blinds (applied from the next hand), starting stack, rebuys, an adjustable turn timer (30 seconds by default, 0 turns it off) with a countdown on the acting player's seat, and removing players. The host deals every hand with a **Deal next hand** button, so the table can take a break between hands (if the host goes offline, anyone can deal)
- Bots: the host can fill seats with computer players in three styles: **Fish** (easy, calls too much), **Shark** (solid, respects pot odds) and **Maniac** (bets big and bluffs often). Bots estimate their chances by simulating hundreds of random hands each turn. They only play while at least one person is at the table, and they automatically buy back in when rebuys are on.
- Each player sees the best hand they can make with the board so far, under their seat. At showdown everyone sees every shown hand's name too
- A deck sits on the felt next to the board. Each hand it shuffles, then hole cards fly out one at a time, starting left of the dealer button. Your own cards flip face up as they land. Flop, turn and river cards slide out face down and flip over in place, and shown-down hands flip over too. Clear D, SB and BB markers show who has the button and the blinds
- Sound effects, all generated in the browser (no audio files): a knock-knock for a check, chips for a bet, a bigger chip rake and chime for winning a pot, card flicks and flips while dealing, and a clock tick in your last 5 seconds
- A settings button (top left) for game sound volume, player voice volume, UI size and card & chip animations, saved in your browser. The system "reduce motion" setting only stops the cards' idle sway. Dealing, flipping and chip movement still play unless you turn off **Card & chip animations**
- Going all in sets your camera ablaze: "NAME / ALL IN" rolls across the whole table in big 3D letters, and a red fire flickers around your camera until the hand is over (a steady red glow with **Card & chip animations** off)
- Chips you can see: each bet slides out in front of the player as a pile that grows with its size, the bets are swept into a pot pile in the middle before the next card comes out, and the pot slides over to the winner
- Classic red-and-black cards, drawn as SVG in [static/poker/cards.js](static/poker/cards.js), built to read at a glance: a big suit in the top-left half and a big rank (2-10, A, K, Q, J) in the bottom-right half. They sway gently and bounce when they're part of the winning hand
- **Check / Fold**: arm it while you wait and it checks for you whenever it's free, then folds the first time you face a bet (it lasts until the end of the hand, or until you turn it off)
- Reactions: the 😂 button in the corner of the table opens a picker with two tabs, and everyone sees your pick:
  - **Stickers** pop up over your seat. They're the images in [poker/stickers/](poker/stickers/) (PNG, GIF, WebP or JPEG). Drop more files in to add them; `6740-skull.gif` shows up as "skull"
  - **Effects** play over your camera. They're the [Lottie](https://lottiefiles.com/) animations (`.json`) in [poker/effects/](poker/effects/); `Poker Chip Shuffle.json` shows up as "Poker Chip Shuffle"
- Sit out, rebuy, a chip ledger (+/−), table chat and a hand log. The right-hand panels can be collapsed to a slim strip that counts unread chat
- Mute your mic or turn your camera off at any time. A disconnected player's turn is checked or folded automatically after 20 seconds.

## Flohdle

Flohdle is a single-player Wordle clone at `/wordle`. Each day's answer is the real NYT Wordle from exactly one year earlier (on Feb 29, the year-earlier Feb 28). The server fetches it from `https://www.nytimes.com/svc/wordle/v2/YYYY-MM-DD.json` and caches it. The answer never goes to the browser until the game is over: the server colours each guess. Progress, stats, streaks and a shareable emoji grid are kept in the browser. Every guess must be a real word from [wordle/words.txt](wordle/words.txt) (the 12,972 words Wordle has accepted) and must use every hint revealed so far: green letters stay in place and yellow letters must appear somewhere (NYT's "hard mode", always on). The server checks both.

## Tests

```
python -m pytest tests
```

## Adding another game

Each game has its own page, files and server addresses, so they don't get in each other's way:

- Page and assets in `static/<game>/` (poker: [static/poker/](static/poker/))
- A route for the page in [main.py](main.py), e.g. `@app.get("/poker")`
- Server addresses under `/api/<game>/...` and `/ws/<game>/...`
- A tile for it on the home page in [static/index.html](static/index.html), replacing or next to the "More games" placeholder

