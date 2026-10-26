# Facebook access: what works, what it needs, and what it cannot do

This app reads Facebook only through the official **Graph API**, with tokens kept on
the server. It does not scrape facebook.com, use a logged-in browser session, or work
around login, rate limits or anti-bot checks. Which Pages can be monitored therefore
depends entirely on **who controls the Page** and **which permissions Meta has granted
your app**.

> **Verification status.** The Graph client has been tested only against a simulated
> Graph API (`test/graph.test.js`, `test/monitor.test.js`). It has **not** yet been run
> against a real Facebook Page, because no Page URLs or credentials have been supplied
> and the build environment could not reach `graph.facebook.com`. Do not treat
> monitoring as working until `npm run fb:check -- <page url>` succeeds against your
> real Pages (see the last section).

## Your source Page: "Live Cities"

You named **Live Cities** (a news channel) as the Page to monitor. Its URL has not been
supplied yet. Please send the exact `facebook.com/...` address.

Live Cities is not an IBN7 Bharat Page, so it falls in the third row of the table below.
The Graph API will only return its posts if one of these is true:

1. **Live Cities grants your business access.** Their Page admin adds your Business
   portfolio as a partner, or gives your system user a task on their Page, in Meta
   Business Suite. This is the realistic route, and it also documents permission to
   reuse their content.
2. Meta approves your app for **Page Public Content Access**. This is unlikely for this
   use case.

Until one of those is in place, add Live Cities in the dashboard anyway. It will show
*no access* with the reason. Process its posters through **Manual import**: save or
screenshot the poster, upload it with the post link, and everything after that (text,
template, review, PNG) is the same.

## Which method works for which Page

| Source Page | Supported method | Works? |
|---|---|---|
| **A Page your organisation manages** (IBN7 Bharat's own Pages, or any Page where your business/user has a task) | Page access token, obtained from a system-user token through `/me/accounts` | **Yes.** This is the main supported path. |
| **Another outlet's Page that agrees to share access** | The other Page's admin adds your Business as a partner (or assigns your system user a task) in Meta Business Suite. The Page then shows up in `/me/accounts` like your own. | **Yes**, once they grant access. This is also the cleanest way to get permission to reuse their content. |
| **A public Page you have no relationship with** | Only with Meta's **Page Public Content Access (PPCA)** feature, which needs App Review and Business Verification | **Usually not.** See below. |
| Any Page, without API access | **Manual import** in the dashboard: an editor saves or screenshots the poster during normal Facebook use and uploads it with the post link | **Yes.** Same pipeline (OCR → template → review), just no automatic detection. |

### Why public Pages you do not manage are the hard case

Reading the posts of a Page you have no role on (`GET /{page-id}/posts`) requires the
**Page Public Content Access** feature. Without it the Graph API returns error `10` or
`100/33` ("missing permissions"), and this app records the Page as `no_access`.

* PPCA is granted only after **App Review** and **Business Verification**, and Meta decides
  case by case whether a use case qualifies. Meta has historically described it as
  meant for things like competitive benchmarking and analytics.
* An app that takes other outlets' posters and republishes their content under a
  different brand is unlikely to match an approved use case, so **expect PPCA to be
  refused**. Nothing in this codebase can change that.
* The Meta Content Library and its API are restricted to qualified researchers and do
  not cover this use either.
* oEmbed ("Meta oEmbed Read") returns embed HTML for a post you already know the URL
  of. It does not list a Page's new posts, so it cannot do monitoring.

If PPCA *is* approved for your app, set `FB_PPCA_APPROVED=true` and the app will use
your user or app token for those Pages.

### Content rights (please read)

The source posters, their wording and their photos belong to the outlets that published
them. Facts themselves are not owned, but republishing another outlet's text word for
word, or their photos, under your logo can raise copyright and platform-policy issues.
The app keeps facts exact and leaves out the source outlet's own branding, and it never
publishes anything automatically. Whether a given poster may be republished is an
editorial and legal decision for your newsroom. The "share access / partner" route above
is the cleanest way to get that permission.

## What to set up (managed Pages)

1. **Create a Meta app** at developers.facebook.com (type: Business). Note the App ID
   and App Secret.
2. **Business Verification** for your Business portfolio (needed for system users and
   for Advanced Access).
3. **Permissions** the app needs:
   * `pages_show_list`: list the Pages the token can access (`/me/accounts`).
   * `pages_read_engagement`: read Page posts, their attachments and captions.
   * `business_management`: only if the Pages are assigned to a **system user**
     through Business Settings.
   With Standard Access these permissions work only for people who hold a role on the
   app. That is enough when the people generating the token also manage the Pages.
   Advanced Access (App Review) is needed if the Pages belong to other businesses.
4. **Create a system user** (Business Settings → Users → System users), assign it the
   Pages to monitor (at least the "Content"/"Analyze" level of access), and **generate a
   token** for your app with the scopes above. A system-user token does not expire,
   which is right for a server that polls around the clock. A long-lived *user* token
   also works but expires after about 60 days.
5. Put the credentials in the server's environment (never in the browser or in git):

   ```env
   FB_APP_ID=...
   FB_APP_SECRET=...            # enables appsecret_proof on every call
   FB_USER_ACCESS_TOKEN=...     # system-user token
   FB_GRAPH_VERSION=v23.0       # set to the newest version your app supports
   # Optional: explicit Page tokens, keyed by Page id or username
   # FB_PAGE_ACCESS_TOKENS={"123456789":"EAAB..."}
   ```

## What the app does with that access

* Resolves each saved Page URL to a Page id (`GET /{username-or-id}?fields=id,name,link`).
* Picks a token in this order: explicit Page token → managed Page token from
  `/me/accounts` → (PPCA only) user/app token. If none applies, it marks the Page
  `no_access` and explains why, without calling the API.
* At each interval it calls
  `GET /{page-id}/posts?fields=id,created_time,message,permalink_url,full_picture,status_type,attachments{…}&since=…`,
  re-reading the last 2 hours to catch late-indexed posts. Each post+image gets a unique
  key (`<post id>#<image index>`), so nothing is processed twice.
* Photo and album posts are queued. Video, link and text-only posts are recorded as
  `skipped`. Posts older than the moment the Page was added (minus the backfill window)
  are recorded as `baseline` and not processed.
* For photos it requests the largest rendition (`GET /{photo-id}?fields=images`) and
  falls back to the attachment image.
* Reads the `X-App-Usage`, `X-Business-Use-Case-Usage` and `X-Page-Usage` headers and
  stops a cycle early above 90% usage. Rate-limit errors (`4`, `17`, `32`, `613`,
  `80001`…) wait for the next cycle, transient errors are retried with backoff, and
  token errors (`190`) mark the Page `token_error`.

Polling at 5–15 minute intervals stays well inside normal limits for a few dozen Pages.
For near-real-time detection on **managed** Pages, Graph API Webhooks (the `feed` field)
are the supported push alternative. They are not wired up yet, and polling covers the
same Pages.

## Verifying against a real Page

Once the environment variables are set on the server:

```bash
npm run fb:check -- https://www.facebook.com/YourPage https://www.facebook.com/OtherPage
```

For each URL this prints the token type, its scopes and expiry, the Pages the token
manages, which access path was used, and the latest five posts with their image/no-image
classification. It exits non-zero if any Page cannot be read. Only after this succeeds
for a Page should its monitoring be considered working. Then add the Page in the
dashboard and confirm that a newly published poster appears within one interval.
