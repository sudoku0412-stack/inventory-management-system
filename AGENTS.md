# Team preferences

The user requests this team structure for this project:

| Role | Requested model | Reasoning effort | Responsibility |
| --- | --- | --- | --- |
| Senior Developer | gpt-5.6-terra | medium | Feature implementation, debugging, consolidated code review |
| Junior Developer | gpt-5.6-luna | low | Small, well-scoped implementation and fixes |
| UI Designer | gpt-5.6-sol | medium | Layout, interaction design, visual polish, accessibility |
| Architect | gpt-6-sol | low | Major architecture decisions only |
| Orchestrator | gpt-5.6-terra | low (user calls this Light) | Routine coordination; escalate to GPT-6 Astra for difficult problems |

Delegate substantive work to the appropriate specialist. Keep the main agent focused on coordination. Start agents only for concrete bounded tasks, within available runtime capabilities and concurrency limits. Do not start idle agents just to populate the roster. Do not silently substitute an unavailable requested model; disclose the limitation. This file records preferences and does not change the current session's model or effort.

Minimize quota use: activate only necessary specialists, give compact self-contained briefs with minimal inherited context, reuse existing agents when suitable, avoid duplicate investigations and unnecessary reviews, batch independent tool reads, and keep user-facing updates and final answers concise. Do not claim guaranteed quota savings. Preserve necessary verification and task completeness.

At setup time, the sub-agent tool allowed four concurrent agents including the orchestrator. Recheck capabilities when delegating. Do not create separate user-facing tasks unless the user requests them.

## Persistent project memory and handover

Read HANDOVER.md at the start of a new chat. These files are the project's persistent memory; update them when decisions or completion status change. Do not claim account-wide memory or that editing these files changes the active chat model.

Use one implementer and one consolidated Senior review per meaningful change. Give Luna small, explicit tasks; give Terra medium substantial features. Escalate after one unsuccessful fix round rather than repeating the same weak handoff. Use the UI Designer for initial designs and substantial UI changes. Verify important browser flows and responsive visual states before claiming completion.

Monitor the account's five-hour usage during active work and before costly phases. If remaining usage is strictly below 15%, notify the user once, stop active agents, and pause work until the user directs otherwise. Do not automatically resume when limits reset. Keep communication short and avoid repetitive status polling.

## Cursor Cloud specific instructions

- Node.js 26.10.0 is installed at `/opt/node-v26`. Shells may resolve an older `/exec-daemon/node` first. Prepend `/opt/node-v26/bin` to `PATH` before `npm start` or `npm test`.
- `npm ci` installs the Wrangler devDependency and is safe to repeat. The local server has no runtime npm packages and no external database: the first `npm start` creates SQLite under `data/`.
- `npm start` serves http://127.0.0.1:3000. Leave `HOST` unset. Do not set `ACCESS_TEAM_DOMAIN` or `ACCESS_AUD` locally; those turn on Cloudflare Access JWT checks.
- Local `GET /api/shop/onboarding-status` and `GET /api/household/access` return 404. That is the single-Shop SQLite fallback, and the inventory UI still loads.
- Every browser module under `public/` must be listed in `publicAssetPaths` in `lib/shared.js`. A missing entry returns 404 and leaves the page blank.
- Gemini suggestions are optional. Without `GEMINI_API_KEY` or `data/gemini.key`, photos still save and name/expiry stay manual.
