# Render deployment proposal

The `render.yaml` file is a proposal, not a live deployment. It targets the editing branch and keeps automatic deploys off. The original `main` branch is unchanged.

## Resources
- One paid Node web service using plan ID `0.5c-512mb`.
- One 1 GB persistent disk mounted at `/var/data`.
- SQLite stored at `/var/data/flood-finder.sqlite`.
- Node 24.15.0, matching local validation.
- HTTPS-only session cookies via `NODE_ENV=production`.
- Health check at `/api/health`.
- No new external database or API keys are required.

Only files inside the disk mount persist across restarts. A free service's default filesystem is not appropriate for keeping reports and accounts. A disk-backed service runs as a single instance. Review Render's displayed service and disk charges before applying this file.

## Pending setup
1. Connect the intended Render account/workspace and authorize access to the private GitHub repository.
2. Validate the Blueprint using the authenticated Render CLI: `render blueprints validate render.yaml`. The CLI was unavailable during this revision, so Render-side validation is still pending.
3. In Render, create a Blueprint from this repository and choose branch `community-interface`.
4. Set `NWS_USER_AGENT` to a project identifier with a suitable public contact. Review the selected region and current charges, then approve deployment.
5. Confirm the deployment succeeds and `/api/health` responds; verify maps, weather alerts, registration, and reports through the public HTTPS URL.
6. Register the initial administrator through the deployed app, then run `npm run admin -- promote <registered-email>` in that service's shell. The command must use the same database path. Sign back in afterward.
7. Verify persistence with an intentional restart using a clearly labeled test report, and create a database backup plan before real community use.

No service was created and no payment was authorized. This file has been checked against the documented fields, but has not passed Render CLI/API validation.

References checked while preparing this proposal:
- https://render.com/docs/blueprint-spec
- https://render.com/docs/disks
- https://render.com/docs/node-version
