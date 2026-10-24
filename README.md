<img width="4000" height="1080" alt="flood finder" src="https://github.com/user-attachments/assets/767455df-18ed-4cbf-bceb-0e062e0300bd" />


**Real community disaster reporting and response-team coordination.** Because powerful storms deserve powerful response.

## Community edition (editing copy)

This branch, `community-interface`, is the revised copy. The original remains on `main`.

Changes include a lighter responsive interface, priority sorting and filtering, Only my reports, fit-to-results mapping, clearer connection states, report flow after sign-in, and fixes for cancelled response assignments and team availability.

See [design plan](docs/DESIGN.md) and [Render deployment proposal](docs/RENDER.md). Figma authoring and live Render deployment remain pending. `render.yaml` proposes paid resources; review charges before applying it.

For a side-by-side local preview, run `PORT=3001 npm start` in this copy, then open http://localhost:3001. Each copy uses its own local data directory. Never commit SQLite files, accounts, or session data.

## Features

Community reports are public: latitude/longitude, descriptions and any address/landmark typed by the reporter are exposed on the map. Avoid names, medical specifics, home addresses, phone numbers or other personally identifying information in reports. Account email addresses and crew contact details are restricted to authorized roles.

## Safety and scope

Flood Finder is a **coordination aid**, is not intended as an emergency services provider. It is an experimental application not yet intended for or verified as a commercial monitoring tool. 

Flood finder serves as the hub for people in a community to help report incidents during hurricanes, tropical storms, or other severe weather events. Officials can take advantage of this app to track and monitor when certain incidents appear, as well as deliver informed messages to their area. The application also uses real time weather data in compound with crowdsourced information. Public reports start `reported` and remain unverified until reviewed. Estimated route geometry from OSRM is **not verified flood-safe**. Do not use the platform as a sole source for immediate life-safety decisions. Always call local emergency services for life-threatening situations.

## Project layout

```text
server.js           HTTP API, authentication, authorization, NWS / routing proxy, SSE
store.js            Persistent database schema and transactions
public/index.html   Landing page, map, operations dashboard, dialogs
public/styles.css   Responsive visual system
public/app.js       Functional browser UI and state
public/favicon.svg  Brand mark
scripts/admin.js    Secure administrator bootstrap
 test/api.test.js   End-to-end HTTP API integration tests
```
## Run locally

1. Install **Node.js 22.13 or later** (the built-in `node:sqlite` module is required). No `npm install` or database account is needed.
2. From this folder run:

   ```sh
   npm start
   ```

3. Open **http://localhost:3000**.
4. Register your account using the UI. Accounts default to `resident` (this prevents arbitrary admin signup).
5. Stop the server, promote the initial administrator, and restart:

   ```sh
   npm run admin -- promote you@example.com
   npm start
   ```

   You can also run the command from a second terminal while the server is running. **Sign out and sign back in** to refresh the UI. The admin command revokes old sessions.
6. As admin, open **Command center** to create response teams and give selected accounts the `responder` role. Assign a responder account as a team lead, enter real base coordinates, and dispatch the team to an incident. Team leads see their work in **My assignments**.

```sh
npm test
```

## Configuration

Copy `.env.example` as a reference. Set environment variables in your shell or hosting provider. Node does **not** automatically read `.env` files; if you want local `.env` loading with Node 22 use `node --env-file=.env server.js`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `DATABASE_PATH` | `./data/flood-finder.sqlite` | Durable SQLite location; **mount a persistent volume in production** |
| `NODE_ENV` | `development` | `production` sets cookies `Secure`; requires HTTPS front-end |
| `TRUST_PROXY` | `0` | Set `1` **only** behind a trusted reverse proxy that overwrites client forwarding headers |
| `NWS_AREAS` | `FL` | State code for official alerts (e.g. `FL`, `NC`, `TX`) |
| `NWS_USER_AGENT` | Sample | Replace with a public contact as recommended by NWS |
| `OSRM_URL` | `https://router.project-osrm.org` | Road route engine (demo public endpoint is not suitable for guaranteed production dispatch) |

## API quick reference

`GET /api/health`, `GET /api/stats`, `GET /api/incidents`, `GET /api/incidents/:id`, `GET /api/alerts`, and `GET /api/stream` are public.

`POST /api/auth/register`, `POST /api/auth/login`, `POST /api/auth/logout` implement account access. Signed-in users can `POST /api/incidents` and `GET /api/incidents/mine`.

`GET /api/teams` and `GET /api/assignments/mine` require responder/admin access. `PATCH /api/assignments/:id` requires the assigned team lead or admin.

`GET /api/admin/users`, `PATCH /api/admin/users/:id`, `POST /api/admin/teams`, `PATCH /api/admin/teams/:id`, `PATCH /api/admin/incidents/:id`, and `GET /api/admin/metrics` require an administrator. `GET /api/route` requires responder/admin access.

## License

MIT; see `LICENSE`.
