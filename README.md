# SENTINEL

SENTINEL is a safety prototype for traveling alone. It compares real road routes, recommends a safer one, and watches the trip. A safety monitor raises a risk score from a distress phrase, a fall, or a stressed voice, then asks "Are you safe?" If nobody answers, it emails guardians a live dashboard link and the last location.

The app is two parts: `frontend/` for the map and SOS screens, and `module2/` for the API that scores routes and runs the emergency flow.

## Screens

These are the running app.

### Route planner

![Safe route planner with the map, SOS monitor, and time-of-day profile](docs/planner.png)

### Compared routes

![Three scored routes beside the map](docs/routes.png)

### Guardian settings

![Guardian emails, emergency contacts, and medical profile](docs/settings.png)

### Live guardian dashboard

![Emergency status, last known location, and trigger reason](docs/guardian.png)

## Features

- Route search and a safety recommendation over real road geometry
- Reroute offer when an incident ahead makes the current route worse. The traveler confirms the switch
- Journey status, with live GPS when the browser allows it
- SOS monitor with manual trigger, distress keywords, fall detection, and optional voice emotion
- Countdown. "I am safe" stands down. Silence escalates
- Guardian email plus a live page at `/dashboard/<emergency-id>`
- Safety assistant that explains the current risk and does not change the score

## Route score

Module 2 builds the route score as:

- 22.5% historical crime, from a district and city gazetteer in compact JSON under `module2/data/` (not raw NCRB spreadsheets)
- 77.5% shared by lighting, crowd, traffic, connectivity, and safe places, in their original proportions
- An extra penalty for incidents on or near the route

Incident impact is severity, closeness, age, and confidence. Older incidents fade.

A reroute is offered only when all three are true:

- current safety is under `CRITICAL_SAFETY_THRESHOLD` (default 60)
- the alternative is better by at least `MIN_SAFETY_IMPROVEMENT` (default 15)
- the extra time is at most `MAX_EXTRA_TRAVEL_MINUTES` (default 10)

## Fall detection

On an HTTPS page, the phone motion sensor reports a fall only when both happen:

1. A near-weightless moment (the phone is in freefall).
2. Within 700 ms, an impact of about 7 g.

Picking the phone up, tilting it, or setting it down does not satisfy both. The Fall button in the UI sends the same signal by hand so the demo still works without a drop. This is a rule on the sensor, not a trained classifier.

## Tech stack

| Piece | Role |
| --- | --- |
| React | Planner, SOS panel, countdown, guardian page |
| Vite | Client build and dev server. Proxies API calls to FastAPI so the phone uses one origin |
| @vitejs/plugin-basic-ssl | HTTPS certificate for the dev server, so a phone may use location, microphone, and motion |
| React Router | `/` is the app. `/dashboard/:emergencyId` is the guardian view |
| Leaflet, OpenStreetMap | Map, route line, last known point. No paid map key |
| Tailwind CSS, shadcn/ui | Layout and controls |
| FastAPI, Uvicorn, Pydantic | JSON API and request checks |
| OpenRouteService | Real road geometry. Requires `ORS_API_KEY` |
| Shapely | Whether an incident lies on the route, and how far along |
| httpx | Calls to OpenRouteService, Overpass, and the assistant model, with timeouts |
| OSM Overpass | Lighting, connectivity, and places along the corridor |
| Web Speech API | Browser speech-to-text for distress phrases |
| Transformers, PyTorch, soundfile | Optional emotion classifier. Keyword rules still run if it is absent |
| Ollama, Groq, or another chat API | Optional wording for the safety assistant. The score is already fixed in Python |
| smtplib | Guardian email |
| In-memory store | Journeys, emergencies, and settings for one demo process |
| pytest | Backend checks for routing, scoring, and SOS |

### Why these, and not the usual alternatives

- **React rather than Angular.** One screen owns the route, the trip, and the SOS score. Angular's structure is more than this demo uses.
- **Vite rather than Next.js.** The client is a single page. FastAPI is already the server. Next would be a second server.
- **FastAPI rather than Django or Node.** The work is JSON in and JSON out, checked with Pydantic. The scoring code stays in Python next to the API.
- **Leaflet and OpenStreetMap rather than Google Maps or Mapbox.** The demo needs a route line and a point, without a billing account.
- **OpenRouteService rather than hosting OSRM.** Real streets from one HTTP call, without operating a road graph.
- **Shapely rather than hand-written distance math.** "Is this incident on this bend of the route?" is a geometry problem.
- **Memory rather than Postgres.** One demo session. A restart clears it. That is acceptable for the demo and not acceptable in production.
- **Web Speech rather than Whisper on the server.** Distress words are spotted in the browser. The typed transcript is the fallback when speech fails.
- **A freefall-then-impact rule rather than a motion model.** A pickup already looks like a spike. The rule demands a drop and then a hard hit, which is easy to explain.
- **Email rather than Twilio.** A link and a location in a mailbox you already have, with no paid phone number.

## Run the project

Use two terminals. Python 3.11 or newer, and Node with npm.

### 1) Backend

```bash
cd module2
python -m pip install -r requirements.txt
cp .env.example .env
```

Set `ORS_API_KEY` in `module2/.env` or the environment. Without it, route search cannot ask OpenRouteService for roads.

SMTP, for guardian email:

```
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USERNAME=your-email@gmail.com
SMTP_PASSWORD=your-app-password
SMTP_FROM=your-email@gmail.com
```

Leave `FRONTEND_BASE_URL` as `http://localhost:5173` during a same-network demo. The API rewrites that localhost default to this machine's network address and port when it builds the guardian link, so a phone on the same network can open it. Set `FRONTEND_BASE_URL` to a public `https://` origin only when the site is actually hosted there.

Share-trip and SOS emails use the same Guardian dashboard URL (`/dashboard/<id>`). After START ROUTE, Home shows Share live location; it posts `/monitor/share`. That emailed Guardian page is the SOS view: it polls live location plus SOS `risk_score` from `/monitor`, `/emergencies`, and `/journeys/.../status`. If SMTP is missing, `MOCK_MODE=true` still builds the email HTML, logs it, and stores it in memory so the demo can continue. Guardian emails come from Settings (`guardian_emails`). When browser GPS is off, the dashboard uses last-known from the navigation journey position. Home does not send people to check mail for a second dashboard.

```bash
cd module2
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

API docs: http://localhost:8000/docs

### 2) Frontend

```bash
cd frontend
npm install
npx vite --host
```

`@vitejs/plugin-basic-ssl` is a dev dependency. The first `npm install` after pulling must finish before Vite will start. Vite prints local and network URLs.

- On the demo laptop, open the `https://localhost:5173` URL.
- On a phone on the same network, open the `https://` URL whose address is the Wi-Fi or VPN address of this computer (often a `10.x` address). Accept the certificate warning. That warning is the local dev certificate, not a broken page.
- Ignore virtual-adapter addresses such as `192.168.56.1` (VirtualBox or Hyper-V host-only). The phone is not on that network, so the page will not load.

Location, microphone, and fall sensing stay blocked on plain `http://` when the page is opened by IP. Use the `https://` URL.

### 3) Safety assistant (optional)

The chat button calls `POST /assistant/ask`. For a local model:

1. Install [Ollama](https://ollama.com) and run `ollama pull qwen3:4b`.
2. Keep Ollama running.
3. In `module2/.env`:

```
LLM_PROVIDER=ollama
LLM_MODEL=qwen3:4b
MOCK_MODE=false
LLM_TIMEOUT_SECONDS=120
```

`MOCK_MODE` must be `false`, or the assistant stays on the offline fallback. Restart Uvicorn after changing `.env`. Groq or another provider works too if `LLM_PROVIDER`, `LLM_MODEL`, and the matching API key are set.

## Demo

1. Save two guardian emails in Settings. The monitor will not arm without them.
2. Pick a start and a destination. Search routes. Compare the score and the factor bars.
3. Start the journey. Use "Demo: inject accident 600 m ahead". Accept or keep the reroute. The app offers. The person decides.
4. Activate the safety monitor and allow motion and the microphone.
5. Type `help me`, or drop the phone onto a soft surface, or press Manual SOS.
6. Show the countdown. Let it expire, or press "I am safe" on a second run.
7. Open the guardian link from the on-screen notice or the email. It polls every 5 seconds and shows status, trigger, last location, and activity.

If speech recognition fails with `network`, use the transcript box. Chrome's speech service is what failed, not the SOS score.

## Tests

```bash
cd module2
python -m pytest -q
```

## What this demo is not

- It does not call the police or an ambulance.
- The crime layer is a district and city lookup packaged with the app. It is not a live, validated crime map for the city on the screen.
- Fall detection is the freefall-and-impact rule, not a trained fall classifier.
- Guardian links are unauthenticated. Anyone with the URL can open that emergency.
- State lives in memory. Restarting Uvicorn clears journeys, emergencies, and settings.
- There is no offline mode. The phone has to reach the machine running Vite and Uvicorn.

## Production, later

Serve the frontend on a normal HTTPS host. Point it at a public API URL. The Vite proxy does not exist in production. Move the store to a database, restrict CORS to that site, turn `DEMO_MODE` off, and put a token on guardian links.
