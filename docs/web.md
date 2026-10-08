# Daily view and weight management

Use the dashboard to review your ledger. Create records and change goals through an MCP client or the REST API. The web app has no health-record or goal editing controls.

import { Screenshot } from "/snippets/oss/screenshot.jsx";

<Screenshot light="/assets/dashboard-light.png" dark="/assets/dashboard-dark.png" alt="Daily View showing sample nutrition, water, mood and exercise next to the day's logs" width={1280} height={824} caption="Daily View with synthetic observations and example goals. The dashboard shows records supplied through MCP or REST." />

## Sign in

Open your installation's UI and sign in with its configured root email and password. The dashboard session is read-only for health data and expires after 30 days. Sign out from the account menu when using a shared device.

## Daily view

Open **Daily View** and choose a date from the calendar. The date follows your installation's configured timezone. On wider screens the summary and logs sit beside each other; on a phone the logs appear below the summary.

The summary shows energy, protein, carbohydrates, fat, fiber, the latest recorded mood, water, active calories and exercise minutes. Select a log to expand its details, including reusable attachment previews when present. Event times appear only when supplied; date-only observations do not acquire invented times.

Daily numeric cards display zero when no usable measurement is available. Mood displays **Not recorded**. These are display defaults: they do not create observations or replace the API's unknown values. Reported daily totals take precedence over compatible individual entries; unresolved overlapping exercise remains unknown. Water counts logged water rather than all fluids.

## Goal progress

Set explicit goals through [MCP or REST](goals.md). Progress bars appear only when a goal applies to the selected date. Nutrition goals are upper limits; water and exercise goals are minimum targets. The small marker shows elapsed-day progress, not a measured health value.

A target is a value you supply. Vitalog does not choose health targets or infer missing measurements. An empty progress bar can mean there is no usable observation yet; inspect the logs and API summary when that distinction matters.

## Weight management

Open **Weight Management** to see the latest usable scalar weight on or before today, a 30-day chart and paginated weigh-ins. Values display in kilograms; supported supplied units are converted by the API. Missing days remain gaps. Qualified or excluded readings cannot become the current weight.

A weight goal can include an explicit starting baseline and target. Changing a target preserves its baseline unless your client explicitly replaces it. Vitalog does not infer a baseline from the earliest observation.

## Account settings

Use **Account Settings → Profile** to save a display name, and **Preferences** to choose date/time formatting. Email and password remain operator-managed. The account menu includes the public [documentation](https://www.vitalog.dev).

**API Keys**, **MCP Connections** and **MCP Guide** manage client access. Creating or revoking credentials requires a separate root verification; the resulting management session lasts 30 minutes and cannot access health data. See [API keys](api-keys.md) and [OAuth](oauth.md).

The sidebar can collapse on desktop or open as a drawer on mobile. Theme settings support light, dark and system appearance. Account and theme preferences persist independently of health observations.

## Backend interruptions

If the API becomes unavailable, the app shows a reconnecting screen and retries automatically. Once the API recovers, it refreshes the page. An expired or revoked session returns to sign-in. Repeated interruptions should be investigated through [operations and health checks](https://www.vitalog.dev/operations), rather than entering duplicate records.
